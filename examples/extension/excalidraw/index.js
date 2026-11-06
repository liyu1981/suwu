/**
 * Excalidraw — a whiteboard whose React app is loaded from the upstream npm
 * package through esm.sh at runtime. No Excalidraw/React sources are vendored
 * in this repository; package.json declares the CSP sources that esm.sh needs.
 *
 * Static files are public: never put secrets here.
 */
function handler() {
  const file = (input && input.params && input.params.file) || (input && input.query && input.query.file) || "";
  let scene = "";
  if (file) {
    try { scene = fs.readFileSync("/fs/" + file.split("/").pop()); } catch (e) { scene = ""; }
  }
  const token = (input && input.token) || ""; const inject = `<script>window.__SUWU_FILE__=${JSON.stringify(file)};window.__SUWU_SCENE__=${JSON.stringify(scene)};window.__SUWU_TOKEN__=${JSON.stringify(token)};</script>`;
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Excalidraw</title>
<link rel="stylesheet" href="https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/index.css">
<link rel="stylesheet" href="/gqjs/static/excalidraw/page.css">
<script type="importmap">
{
  "imports": {
    "react": "https://esm.sh/react@19.3.1",
    "react/jsx-runtime": "https://esm.sh/react@19.3.1/jsx-runtime",
    "react-dom": "https://esm.sh/react-dom@19.3.1?external=react",
    "react-dom/client": "https://esm.sh/react-dom@19.3.1/client?external=react",
    "@excalidraw/excalidraw": "https://esm.sh/@excalidraw/excalidraw@0.18.1?external=react,react-dom"
  }
}
</script>
<script>
// The extension document is sandboxed with an opaque origin, where the web
// storage APIs throw. Excalidraw expects localStorage for theme/UI state, so
// install an in-memory fallback. The actual scene is persisted separately via
// the parent frame's ext-store bridge.
(function () {
  function memoryStorage() {
    var data = Object.create(null);
    return {
      getItem: function (key) {
        return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
      },
      setItem: function (key, value) { data[key] = String(value); },
      removeItem: function (key) { delete data[key]; },
      clear: function () { data = Object.create(null); },
      key: function (index) {
        var keys = Object.keys(data);
        return index >= 0 && index < keys.length ? keys[index] : null;
      },
      get length() { return Object.keys(data).length; }
    };
  }
  function install(name) {
    try {
      window[name].setItem("__suwu_probe__", "1");
      window[name].removeItem("__suwu_probe__");
      return;
    } catch (e) {}
    var store = memoryStorage();
    try {
      Object.defineProperty(window, name, { configurable: true, get: function () { return store; } });
    } catch (e) {
      try { window[name] = store; } catch (e2) {}
    }
  }
  install("localStorage");
  install("sessionStorage");

  // Fonts and lazily imported chunks resolve through esm.sh.
  window.EXCALIDRAW_ASSET_PATH = "https://esm.sh/@excalidraw/excalidraw@0.18.1/dist/prod/";
})();
</script>
${inject}</head>
<body>
<div id="root"></div>
<div id="suwu-status" aria-live="polite"></div>
<script type="module" src="/gqjs/static/excalidraw/app.js"></script>
</body>
</html>
`,
  };
}
