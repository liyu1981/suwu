(function () {
  const g = globalThis;

  // --- fs.promises facade over synchronous host I/O -----------------------
  // In the request-scoped model host I/O is blocking; exposing it as async
  // keeps the JS API idiomatic (`await fs.promises.readFile(...)`) without
  // ever resolving a Promise from another goroutine.
  if (g.fs && !g.fs.promises) {
    g.fs.promises = {
      readFile: async (p, enc) => g.fs.readFileSync(p, enc),
      writeFile: async (p, data, enc) => g.fs.writeFileSync(p, data, enc),
      readdir: async (p) => g.fs.readdirSync(p),
      stat: async (p) => g.fs.statSync(p),
      unlink: async (p) => g.fs.unlinkSync(p),
      mkdir: async (p, o) => g.fs.mkdirSync(p, o),
    };
  }

  // --- require() for builtins --------------------------------------------
  const builtins = {
    fs: g.fs,
    path: g.path,
    process: g.process,
    console: g.console,
  };
  if (!g.require) {
    g.require = function require(name) {
      const key = String(name).replace(/^node:/, "");
      if (Object.prototype.hasOwnProperty.call(builtins, key)) {
        return builtins[key];
      }
      throw new Error(
        "Cannot find module '" + name + "' (this runner only provides builtins: " +
          Object.keys(builtins).join(", ") + ")"
      );
    };
  }

  // --- timers (synchronous, bounded by the request deadline) --------------
  if (!g.setTimeout) {
    g.setTimeout = function setTimeout(fn, ms, ...args) {
      g.__gqjs.sleep(Number(ms) || 0);
      if (typeof fn === "function") return fn(...args);
      return undefined;
    };
    g.clearTimeout = function clearTimeout() {};
    g.setInterval = function setInterval() {
      throw new Error("setInterval is not supported in the request-scoped runner");
    };
    g.clearInterval = function clearInterval() {};
  }

  // --- CommonJS scaffolding ----------------------------------------------
  if (!g.module) {
    g.module = { exports: {} };
    g.exports = g.module.exports;
  }

  // --- fetch: the modern Fetch API over synchronous host I/O ------------------
  // Request-scoped: the host performs the whole HTTP request inside the call
  // (bounded by the request deadline), so the Promise settles immediately —
  // there is no event loop to wait on and no connection outlives the call.
  // Only the modern surface exists here: fetch / Headers / Response with
  // text(), json() and arrayBuffer(). No XMLHttpRequest, no WebSocket, no
  // ReadableStream/Blob bodies, no cookie jar (credentials options are
  // ignored). Requires --allow-net on the runner; see doc.go.

  // QuickJS ships neither TextDecoder nor TextEncoder.
  function utf8Run(bytes, start, end) {
    let out = "";
    for (let s = start; s < end; s += 8192) {
      out += String.fromCharCode.apply(null, bytes.subarray(s, Math.min(s + 8192, end)));
    }
    return out;
  }

  function utf8Decode(bytes) {
    const FFFD = "\ufffd";
    let out = "";
    const n = bytes.length;
    let i = 0;
    while (i < n) {
      const runStart = i;
      while (i < n && bytes[i] < 0x80) i++;
      if (i > runStart) out += utf8Run(bytes, runStart, i);
      if (i >= n) break;
      const b0 = bytes[i];
      let cp = 0;
      let extra = 0;
      if (b0 >= 0xc2 && b0 <= 0xdf) { extra = 1; cp = b0 & 0x1f; }
      else if (b0 >= 0xe0 && b0 <= 0xef) { extra = 2; cp = b0 & 0x0f; }
      else if (b0 >= 0xf0 && b0 <= 0xf4) { extra = 3; cp = b0 & 0x07; }
      else { out += FFFD; i++; continue; } // stray continuation or invalid lead
      if (i + extra >= n) { out += FFFD; break; } // truncated tail
      let matched = 0;
      for (let k = 1; k <= extra; k++) {
        const b = bytes[i + k];
        if ((b & 0xc0) !== 0x80) break;
        matched = k;
        cp = (cp << 6) | (b & 0x3f);
      }
      if (matched < extra) { out += FFFD; i += matched + 1; continue; }
      i += extra + 1;
      const minCp = extra === 1 ? 0x80 : extra === 2 ? 0x800 : 0x10000;
      if (cp < minCp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) { out += FFFD; continue; }
      if (cp < 0x10000) {
        out += String.fromCharCode(cp);
      } else {
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      }
    }
    return out;
  }

  function utf8Encode(str) {
    const bytes = new Uint8Array(str.length * 3);
    let j = 0;
    for (let i = 0; i < str.length; i++) {
      let cp = str.charCodeAt(i);
      if (cp >= 0xd800 && cp <= 0xdbff) {
        const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
          i++;
        } else {
          cp = 0xfffd;
        }
      } else if (cp >= 0xdc00 && cp <= 0xdfff) {
        cp = 0xfffd;
      }
      if (cp < 0x80) bytes[j++] = cp;
      else if (cp < 0x800) {
        bytes[j++] = 0xc0 | (cp >> 6);
        bytes[j++] = 0x80 | (cp & 63);
      } else if (cp < 0x10000) {
        bytes[j++] = 0xe0 | (cp >> 12);
        bytes[j++] = 0x80 | ((cp >> 6) & 63);
        bytes[j++] = 0x80 | (cp & 63);
      } else {
        bytes[j++] = 0xf0 | (cp >> 18);
        bytes[j++] = 0x80 | ((cp >> 12) & 63);
        bytes[j++] = 0x80 | ((cp >> 6) & 63);
        bytes[j++] = 0x80 | (cp & 63);
      }
    }
    return bytes.subarray(0, j);
  }

  // No atob/btoa in this runtime either.
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const B64_IDX = Object.create(null);
  for (let i = 0; i < 64; i++) B64_IDX[B64[i]] = i;

  function b64Encode(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i];
      const b1 = i + 1 < bytes.length ? bytes[i + 1] : -1;
      const b2 = i + 2 < bytes.length ? bytes[i + 2] : -1;
      out += B64[b0 >> 2];
      out += B64[((b0 & 3) << 4) | (b1 < 0 ? 0 : b1 >> 4)];
      out += b1 < 0 ? "=" : B64[((b1 & 15) << 2) | (b2 < 0 ? 0 : b2 >> 6)];
      out += b2 < 0 ? "=" : B64[b2 & 63];
    }
    return out;
  }

  function b64Decode(s) {
    const clean = String(s).replace(/\s/g, "").replace(/=+$/, "");
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4) + 1);
    let buf = 0;
    let bits = 0;
    let j = 0;
    for (let i = 0; i < clean.length; i++) {
      const v = B64_IDX[clean[i]];
      if (v === undefined) throw new TypeError("fetch: invalid base64 body");
      // Mask to 24 bits: only the low pending bits matter, and an unmasked
      // buf would drift past 2^53 on long bodies, corrupting low bits.
      buf = ((buf << 6) | v) & 0xffffff;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[j++] = (buf >> bits) & 0xff;
      }
    }
    return out.subarray(0, j);
  }

  if (!g.Headers) {
    g.Headers = class Headers {
      constructor(init) {
        this._list = [];
        if (!init) return;
        if (init instanceof Headers) {
          for (const [k, v] of init._list) this._list.push([k, v]);
        } else if (Array.isArray(init)) {
          for (const pair of init) {
            if (pair && pair.length >= 2) this.append(pair[0], pair[1]);
          }
        } else {
          for (const k of Object.keys(init)) this.append(k, init[k]);
        }
      }
      append(name, value) {
        this._list.push([String(name).toLowerCase(), String(value)]);
      }
      set(name, value) {
        this.delete(name);
        this.append(name, value);
      }
      get(name) {
        const key = String(name).toLowerCase();
        const hits = [];
        for (const [k, v] of this._list) if (k === key) hits.push(v);
        return hits.length ? hits.join(", ") : null;
      }
      has(name) {
        return this.get(name) !== null;
      }
      delete(name) {
        const key = String(name).toLowerCase();
        this._list = this._list.filter(([k]) => k !== key);
      }
      forEach(cb, thisArg) {
        for (const [k, v] of this.entries()) cb.call(thisArg, v, k, this);
      }
      *entries() {
        yield* this._list;
      }
      *keys() {
        for (const [k] of this._list) yield k;
      }
      *values() {
        for (const [, v] of this._list) yield v;
      }
      [Symbol.iterator]() {
        return this.entries();
      }
    };
  }

  if (!g.Response) {
    g.Response = class Response {
      constructor(body, init) {
        init = init || {};
        this.status = init.status === undefined ? 200 : Number(init.status);
        this.statusText = init.statusText === undefined ? "" : String(init.statusText);
        this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers);
        this.ok = this.status >= 200 && this.status <= 299;
        this.url = init.url === undefined ? "" : String(init.url);
        this.redirected = !!init.redirected;
        this.type = init.type === undefined ? "default" : String(init.type);
        this.bodyUsed = false;
        this._src = body === undefined || body === null ? null : String(body);
        this._b64 = ""; // filled below for network responses
        this._bytes = null;
      }
      _take() {
        if (this.bodyUsed) throw new TypeError("Body is unusable: body already read");
        this.bodyUsed = true;
        if (this._bytes === null) {
          if (this._src !== null) this._bytes = utf8Encode(this._src);
          else this._bytes = this._b64 ? b64Decode(this._b64) : new Uint8Array(0);
        }
        return this._bytes;
      }
      async text() {
        return utf8Decode(this._take());
      }
      async json() {
        return JSON.parse(await this.text());
      }
      async arrayBuffer() {
        const b = this._take();
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      }
    };
  }

  if (typeof g.fetch !== "function" && g.__gqjs && typeof g.__gqjs.fetch === "function") {
    g.fetch = async function fetch(input, init) {
      init = init || {};
      const url = typeof input === "string" ? input : String(input);
      const method = String(init.method || "GET").toUpperCase();
      const headers = new Headers(init.headers);
      const redirect = init.redirect === undefined ? "follow" : String(init.redirect);
      if (redirect !== "follow" && redirect !== "error" && redirect !== "manual") {
        throw new TypeError('fetch: redirect must be "follow", "error" or "manual"');
      }

      let textBody = null;
      let b64Body = null;
      if (init.body !== undefined && init.body !== null) {
        if (method === "GET" || method === "HEAD") {
          throw new TypeError("Request with GET/HEAD method cannot have body.");
        }
        const b = init.body;
        if (typeof b === "string") textBody = b;
        else if (b instanceof Uint8Array) b64Body = b64Encode(b);
        else if (b instanceof ArrayBuffer) b64Body = b64Encode(new Uint8Array(b));
        else if (ArrayBuffer.isView(b)) {
          b64Body = b64Encode(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
        } else textBody = String(b);
      }

      const spec = { url, method, redirect, headers: headers._list };
      if (textBody !== null) spec.text = textBody;
      if (b64Body !== null) spec.b64 = b64Body;

      const wire = JSON.parse(g.__gqjs.fetch(JSON.stringify(spec)));
      if (wire.error) {
        if (wire.kind === "url" || wire.kind === "network" || wire.kind === "redirect") {
          throw new TypeError(wire.error);
        }
        throw new Error(wire.error);
      }
      const res = new Response(null, {
        status: wire.status || 200,
        statusText: wire.statusText || "",
        headers: wire.headers || [],
        url: wire.url || "",
        redirected: !!wire.redirected,
        type: "basic",
      });
      res._b64 = wire.b64 || "";
      return res;
    };
  }
})();
