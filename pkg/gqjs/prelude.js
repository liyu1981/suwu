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
})();
