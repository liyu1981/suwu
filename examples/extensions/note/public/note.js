/**
 * Note — seven fixed slots shown as numbered chips over one flat 3M
 * Post-it.
 *
 * Pure client: nothing leaves the browser. The sandboxed (opaque-origin)
 * frame has no web storage of its own, so reads and writes go over a
 * scoped postMessage bridge to the trusted parent frame, which keeps them
 * in its IndexedDB under this extension's key namespace
 * (docs/EXTENSION_TILE_PLAN.md §4.8). This file is public: it must never
 * contain secrets (docs/EXTENSION_API_PLAN.md §2.8).
 */
(function () {
  "use strict";

  var RECORD = "v1"; // storage key suffix; the parent namespaces it
  var COUNT = 7;
  var MAX_LEN = 1500;
  var COLORS = ["yellow", "pink", "blue", "green"]; // 3M sticky palette
  var REPLY_TIMEOUT = 3000;

  var tabsEl = document.getElementById("tabs");
  var tabs = Array.prototype.slice.call(tabsEl.querySelectorAll(".tab"));
  var postit = document.getElementById("postit");
  var editor = document.getElementById("editor");
  var statusEl = document.getElementById("status");

  var state = { active: 0, texts: pad([]) };
  var saveTimer = null;
  var reqId = 0;
  var pending = Object.create(null);

  function pad(texts) {
    var out = [];
    for (var i = 0; i < COUNT; i++) {
      out.push(typeof texts[i] === "string" ? texts[i].slice(0, MAX_LEN) : "");
    }
    return out;
  }

  // Validate the stored shape; anything else starts fresh.
  function normalize(raw) {
    if (!raw || !Array.isArray(raw.texts)) return null;
    var active = raw.active | 0;
    if (active < 0 || active >= COUNT) active = 0;
    return { active: active, texts: pad(raw.texts) };
  }

  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  function saveFail(name) {
    setStatus(
      name === "QuotaExceededError"
        ? "Storage full — changes may not be saved."
        : "Couldn't save changes.",
    );
  }

  function nameErr(name) {
    var e = new Error(name);
    e.name = name;
    return e;
  }

  // ---- storage bridge to the trusted parent frame (§4.8) ----
  // Replies are matched by rid; only the parent's messages are accepted.

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || d.type !== "ext-store-result" || typeof d.rid !== "number") return;
    var p = pending[d.rid];
    if (!p) return;
    delete pending[d.rid];
    clearTimeout(p.timer);
    if (d.ok) {
      p.resolve(d.value);
    } else {
      p.reject(nameErr(typeof d.error === "string" && d.error ? d.error : "StoreFailed"));
    }
  });

  function storeCall(op, key, value) {
    return new Promise(function (resolve, reject) {
      if (window.parent === window) {
        reject(nameErr("NoParent")); // opened outside the tile page: memory only
        return;
      }
      var rid = ++reqId;
      var timer = setTimeout(function () {
        delete pending[rid];
        reject(nameErr("Timeout"));
      }, REPLY_TIMEOUT);
      pending[rid] = { resolve: resolve, reject: reject, timer: timer };
      var msg = { type: "ext-store", op: op, key: key, rid: rid };
      if (op === "set") msg.value = value;
      try {
        window.parent.postMessage(msg, "*");
      } catch (err) {
        clearTimeout(timer);
        delete pending[rid];
        reject(err);
      }
    });
  }

  function save() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    storeCall("set", RECORD, { active: state.active, texts: state.texts })
      .then(function () {
        setStatus("");
      })
      .catch(function (e) {
        saveFail(e && e.name);
      });
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 250);
  }

  // Show slot i: recolor the Post-it, swap the text, mark the dot.
  // Focus follows only for user-initiated switches — boot never steals it
  // (the focus relay would claim the pane).
  function select(i, focus) {
    state.active = i;
    postit.className = "postit color-" + COLORS[i % COLORS.length];
    editor.value = state.texts[i] || "";
    for (var n = 0; n < tabs.length; n++) {
      tabs[n].setAttribute("aria-selected", n === i ? "true" : "false");
    }
    if (focus) editor.focus();
    save();
  }

  function wire() {
    tabsEl.addEventListener("click", function (e) {
      var t = e.target && e.target.closest ? e.target.closest(".tab") : null;
      if (!t) return;
      var idx = parseInt(t.getAttribute("data-i"), 10);
      if (!isNaN(idx)) select(idx, true);
    });

    editor.addEventListener("input", function () {
      state.texts[state.active] = editor.value.slice(0, MAX_LEN);
      scheduleSave();
    });

    // Best-effort flush when the page goes away; the postMessage is queued
    // on the parent at dispatch time, so it survives the child's teardown.
    window.addEventListener("pagehide", function () {
      if (saveTimer) save();
    });
  }

  // Boot: ask the parent for the record, then paint + wire. Nothing is
  // interactive before the answer (or its timeout) lands, so early
  // keystrokes can never be overwritten by a late load.
  storeCall("get", RECORD)
    .then(function (value) {
      var stored = normalize(value);
      if (stored) state = stored;
    })
    .catch(function () {
      setStatus("Couldn't save changes.");
    })
    .then(function () {
      select(state.active, false);
      wire();
    });
})();
