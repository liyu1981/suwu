/**
 * Excalidraw — mount the upstream component loaded from esm.sh.
 *
 * The extension keeps no vendored Excalidraw/React code. index.js supplies an
 * import map that pins React and Excalidraw on esm.sh, so React is a single
 * instance. See ../package.json for the CSP extras this requires.
 *
 * Public file: never put secrets here.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw } from "@excalidraw/excalidraw";

const STORE_KEY = "scene";
const MAX_SAVED_BYTES = 500000;
const APP_STATE_KEYS = [
  "gridSize",
  "gridStep",
  "gridModeEnabled",
  "zenModeEnabled",
  "scrollX",
  "scrollY",
  "zoom",
  "currentItemStrokeColor",
  "currentItemBackgroundColor",
  "currentItemFillStyle",
  "currentItemStrokeWidth",
  "currentItemRoughness",
  "currentItemOpacity",
  "currentItemFontFamily",
  "currentItemFontSize",
  "currentItemTextAlign",
  "currentItemStrokeStyle",
  "currentItemArrowType",
  "currentItemRoundness"
];

/** Minimal copy of the parent-frame storage bridge (see note/public/bridge.js). */
function createBridge(parent) {
  const pending = Object.create(null);
  let seq = 0;
  window.addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const d = e.data;
    if (!d || d.type !== "ext-store-result" || typeof d.rid !== "number") return;
    const entry = pending[d.rid];
    if (!entry) return;
    delete pending[d.rid];
    clearTimeout(entry.timer);
    if (d.ok) entry.resolve(d.value);
    else entry.reject(new Error(typeof d.error === "string" && d.error ? d.error : "StoreFailed"));
  });
  function call(op, key, value) {
    return new Promise((resolve, reject) => {
      if (parent === window) {
        reject(new Error("NoParent"));
        return;
      }
      const rid = ++seq;
      const timer = setTimeout(() => {
        delete pending[rid];
        reject(new Error("Timeout"));
      }, 3000);
      pending[rid] = { resolve, reject, timer };
      const msg = { type: "ext-store", op, key, rid };
      if (op === "set") msg.value = value;
      try {
        parent.postMessage(msg, "*");
      } catch (err) {
        clearTimeout(timer);
        delete pending[rid];
        reject(err);
      }
    });
  }
  return {
    get: (key) => call("get", key),
    set: (key, value) => call("set", key, value)
  };
}

const bridge = createBridge(window.parent);
let api = null;
let ready = false;
let saveTimer = 0;

function pickAppState(state) {
  const out = {};
  for (const key of APP_STATE_KEYS) {
    if (state && state[key] !== undefined) out[key] = state[key];
  }
  return out;
}

function App() {
  const onExcalidrawAPI = React.useCallback((instance) => {
    api = instance;
    bridge
      .get(STORE_KEY)
      .then((saved) => {
        if (!saved || !api) return;
        api.updateScene({
          elements: Array.isArray(saved.elements) ? saved.elements : [],
          appState: pickAppState(saved.appState),
          files: saved.files,
          commitToHistory: false
        });
      })
      .catch(() => {
        /* No parent bridge: session-only whiteboard. */
      })
      .finally(() => {
        ready = true;
      });
  }, []);

  const onChange = React.useCallback((elements, appState, files) => {
    if (!ready) return;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const payload = { elements, appState: pickAppState(appState), files };
      let encoded;
      try {
        encoded = JSON.stringify(payload);
      } catch {
        return;
      }
      if (encoded.length > MAX_SAVED_BYTES) {
        console.warn("[excalidraw] scene is too large to persist; use Export to keep it");
        return;
      }
      bridge.set(STORE_KEY, payload).catch(() => {});
    }, 800);
  }, []);

  return React.createElement(Excalidraw, {
    name: "Excalidraw",
    onExcalidrawAPI,
    onChange
  });
}

createRoot(document.getElementById("root")).render(React.createElement(App));
