/**
 * Bento host shim — the Suwu tile as a Bento "host".
 *
 * Bento's file I/O keys off one thing: `typeof window.showSaveFilePicker ===
 * 'function'`. When it exists, ⌘S, the Save button, the dirty indicator and the
 * in-place write-back all take the File System Access path instead of falling
 * back to a download. This shim supplies that function and routes the write to
 * the Suwu server, so a deck edited in the tile saves to the file it was opened
 * from — no menu surgery, no reimplementation of Bento's save UI.
 *
 * What the kernel hands us (kernel/src/save.ts):
 *
 *   showSaveFilePicker({ suggestedName, startIn?, id, types })
 *     id = 'bento-doc'    in-place save          → write the open deck
 *          'bento-copy'   "Save a copy…"         → a second file beside it
 *          'bento-share'  export/share artifact  → a download
 *          'bento-backup' the rollback copy      → a download
 *     returns { createWritable() -> { write(Blob), close() }, getFile?(), name }
 *
 * Only `id` distinguishes them, which is exactly why upstream made it explicit:
 * a host that guesses wrong overwrites the open document instead of copying it.
 *
 * Uploads go through the extension API in parts (its body cap is 4 MiB, and a
 * deck with images passes that quickly). See ../save.js for the assembly side.
 */
(function () {
  "use strict";

  var cfg = window.__SUWU || {};
  var base = cfg.api || "/gqjs/api/bento/";
  var PART = 512 * 1024; // bytes of HTML per request, well under the 4 MiB cap
  var MAX_BYTES = 32 * 1024 * 1024;

  // --- storage fallback ------------------------------------------------------
  //
  // The tile is a sandboxed frame with an opaque origin, where the web storage
  // APIs throw. Bento keeps a crash-recovery copy and a collab member key; with
  // no storage it must not throw at boot. In-memory keeps the session usable
  // (recovery dies with the tab, which is the honest trade for now).
  function memoryStorage() {
    var data = Object.create(null);
    return {
      getItem: function (k) {
        return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null;
      },
      setItem: function (k, v) {
        data[k] = String(v);
      },
      removeItem: function (k) {
        delete data[k];
      },
      clear: function () {
        data = Object.create(null);
      },
      key: function (i) {
        var keys = Object.keys(data);
        return i >= 0 && i < keys.length ? keys[i] : null;
      },
      get length() {
        return Object.keys(data).length;
      },
    };
  }
  function installStorage(name) {
    try {
      window[name].setItem("__suwu_probe__", "1");
      window[name].removeItem("__suwu_probe__");
      return;
    } catch (e) {}
    var store = memoryStorage();
    try {
      Object.defineProperty(window, name, { configurable: true, get: function () { return store; } });
    } catch (e) {
      try {
        window[name] = store;
      } catch (e2) {}
    }
  }
  installStorage("localStorage");
  installStorage("sessionStorage");

  // Announce the capabilities Bento asks about. 'store' is not claimed yet: the
  // documented DocStore protocol (__bento_tray__) is a phase-2 item, and claiming
  // a capability we do not answer would make Bento wait on a host that never
  // replies.
  window.__bentoHost = { ops: [] };

  // --- helpers ---------------------------------------------------------------

  function deckName() {
    var file = cfg.file || "";
    var base = file.split("/").pop();
    return base || "Untitled.bento.html";
  }

  function enc(s) {
    return encodeURIComponent(s);
  }

  function post(path, body) {
    // `path` may already carry a query (?file=…), so the token joins it with the
    // right separator instead of starting a second one.
    var sep = path.indexOf("?") < 0 ? "?" : "&";
    return fetch(base + path + sep + "token=" + enc(cfg.token || ""), {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: body,
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try {
          data = JSON.parse(text);
        } catch (e) {}
        if (!res.ok) {
          var msg = (data && data.error) || "HTTP " + res.status;
          throw new Error(msg);
        }
        return data || {};
      });
    });
  }

  /**
   * Split at UTF-16 code-unit boundaries, never between a surrogate pair: the
   * server hands each part back as a JS string, and a lone surrogate would be
   * mangled on the way through JSON.
   */
  function splitParts(text, size) {
    var parts = [];
    var i = 0;
    while (i < text.length) {
      var end = Math.min(i + size, text.length);
      if (end < text.length) {
        var code = text.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end -= 1; // keep the pair together
      }
      if (end === i) end = i + 1; // pathological input: always make progress
      parts.push(text.slice(i, end));
      i = end;
    }
    return parts;
  }

  /** Upload one whole deck to `file`, in parts, and require an assembled answer. */
  function upload(file, text) {
    if (text.length > MAX_BYTES) {
      return Promise.reject(new Error("deck is larger than 32 MB"));
    }
    var parts = splitParts(text, PART);
    var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    var chain = Promise.resolve({});
    for (var i = 0; i < parts.length; i++) {
      (function (index) {
        var url =
          "save?file=" + enc(file) + "&upload=" + enc(id) + "&index=" + index + "&total=" + parts.length;
        chain = chain.then(function () {
          return post(url, parts[index]);
        });
      })(i);
    }
    return chain.then(function (last) {
      if (!last || !last.ok) throw new Error("upload did not complete");
      return last;
    });
  }

  // --- the fake handles ------------------------------------------------------

  /** A writable that buffers the blob and uploads it on close(). */
  function writableFor(file) {
    var blob = null;
    return {
      write: function (data) {
        blob = data;
        return Promise.resolve();
      },
      close: function () {
        if (!blob) return Promise.reject(new Error("nothing written"));
        return blob.text().then(function (text) {
          return upload(file, text);
        });
      },
    };
  }

  /** Write `<base>.copy.bento.html` beside the open deck. */
  function copyFileFor(name) {
    var file = cfg.file || "";
    var slash = file.lastIndexOf("/");
    if (slash < 0) return null;
    var suggested = String(name || "").replace(/[^\w.-]+/g, "_") || "copy.bento.html";
    if (!/\.bento\.html$/i.test(suggested)) suggested = suggested.replace(/\.html?$/i, "") + ".bento.html";
    return file.slice(0, slash + 1) + suggested;
  }

  /** Hand the bytes to the browser as a download (exports, share copies, backups). */
  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name || deckName();
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 60_000);
  }

  function downloadHandle(blob, name) {
    var written = blob || null;
    return {
      name: name || deckName(),
      createWritable: function () {
        return Promise.resolve({
          write: function (data) {
            written = data;
            return Promise.resolve();
          },
          close: function () {
            if (!written) return Promise.reject(new Error("nothing written"));
            download(written, name || deckName());
            return Promise.resolve();
          },
        });
      },
    };
  }

  function serverHandle(file) {
    return {
      name: deckName(),
      createWritable: function () {
        return Promise.resolve(writableFor(file));
      },
      getFile: function () {
        return Promise.resolve(new File([new Blob([""])], deckName(), { type: "text/html" }));
      },
      queryPermission: function () {
        return Promise.resolve("granted");
      },
      requestPermission: function () {
        return Promise.resolve("granted");
      },
    };
  }

  // --- the picker ------------------------------------------------------------

  window.showSaveFilePicker = function (options) {
    var opts = options || {};
    var id = opts.id || "bento-doc";

    // In-place: the only case that may overwrite the opened deck.
    if (id === "bento-doc") {
      // A tile opened without a file has nowhere to write: hand the user a
      // download instead of failing the save. Saving it into a directory and
      // reopening it in Suwu is the documented way to adopt a new deck.
      if (!cfg.file) return Promise.resolve(downloadHandle(null, opts.suggestedName || "Untitled.bento.html"));
      return Promise.resolve(serverHandle(cfg.file));
    }

    // "Save a copy…": a second file beside the original, never the ⌘S target.
    if (id === "bento-copy") {
      var copy = copyFileFor(opts.suggestedName);
      if (copy) return Promise.resolve(serverHandle(copy));
      return Promise.resolve(downloadHandle(null, opts.suggestedName));
    }

    // Share artifacts and update backups are exports: a download, exactly like
    // the plain-browser behaviour for a deck opened from a URL.
    return Promise.resolve(downloadHandle(null, opts.suggestedName));
  };

  // Opening is Suwu's job (the tile is opened on a file), so the app must never
  // run its own open dialog. Not exposing showOpenFilePicker keeps it on the
  // "no handle to start from" path it already handles.
})();
