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
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";

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

// Auto-save: on by default, persisted only in memory (each open starts on).
let autoSaveOn = true;
let autoTimer = 0;
let lastSavedBody = "";

function pickAppState(state) {
  const out = {};
  for (const key of APP_STATE_KEYS) {
    if (state && state[key] !== undefined) out[key] = state[key];
  }
  return out;
}

/** Short label for the mounted file: the last path segment. */
const FILE_PATH = window.__SUWU_FILE__ || "";
const FILE_NAME = FILE_PATH ? FILE_PATH.split("/").pop() : "";

let statusTimer = 0;

/** Show a transient chip in the shell; sticky messages stay until replaced. */
function status(msg, sticky) {
  const el = document.getElementById("suwu-status");
  if (!el) return;
  clearTimeout(statusTimer);
  el.textContent = msg;
  if (!sticky && msg) {
    statusTimer = window.setTimeout(() => {
      el.textContent = "";
    }, 3000);
  }
}

/**
 * POST the current scene to the extension API, which writes the file.
 * `auto` marks the periodic save: it skips writes that would not change the
 * file and words its messages differently.
 */
async function saveScene(auto) {
  if (!api || !FILE_PATH) {
    status(FILE_PATH ? "Scene not ready" : "No file to save to");
    return false;
  }
  const payload = {
    elements: api.getSceneElements(),
    appState: pickAppState(api.getAppState()),
    files: api.getFiles()
  };
  let body;
  try {
    body = JSON.stringify(payload);
  } catch (e) {
    status((auto ? "Auto-save" : "Save") + " failed: scene is not serializable");
    return false;
  }
  if (auto && body === lastSavedBody) return true; // nothing changed
  if (!auto) status("Saving " + FILE_NAME + "\u2026", true);
  const token = window.__SUWU_TOKEN__ || "";
  const url =
    "/gqjs/api/excalidraw/save?token=" +
    encodeURIComponent(token) +
    "&file=" +
    encodeURIComponent(FILE_PATH);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    lastSavedBody = body;
    status((auto ? "Auto-saved " : "Saved ") + FILE_NAME);
    return true;
  } catch (e) {
    status((auto ? "Auto-save" : "Save") + " failed: " + (e && e.message ? e.message : e));
    return false;
  }
}

/** Queue a debounced auto-save: one write per quiet spell, not per keystroke. */
function scheduleAutoSave() {
  window.clearTimeout(autoTimer);
  autoTimer = window.setTimeout(() => {
    if (autoSaveOn && ready) void saveScene(true);
  }, 1000);
}

/** Floppy-disk glyph for the save menu item (menu items take a JSX icon). */
const SAVE_ICON = React.createElement(
  "svg",
  {
    width: 15,
    height: 15,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true",
    focusable: "false"
  },
  React.createElement("path", { d: "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" }),
  React.createElement("path", { d: "M17 21v-8H7v8" }),
  React.createElement("path", { d: "M7 3v5h8" })
);

/**
 * The burger menu. Excalidraw 0.18 has no onSave hook, so a custom MainMenu
 * child is the only way to add a server-side save entry — and supplying it
 * replaces the built-in fallback menu, so the default items are re-listed
 * here.
 *
 * Both of ours are file-only: with no ?file= we render no MainMenu at all and
 * Excalidraw keeps its stock menu.
 */
function buildMainMenu(autoSave, onToggleAutoSave) {
  if (!FILE_PATH) return null;
  const M = MainMenu;
  return React.createElement(
    M,
    null,
    React.createElement(
      M.Item,
      { icon: AUTO_SAVE_ICON, onSelect: onToggleAutoSave, title: "Toggle writing changes back to the file" },
      "Auto save to " + FILE_NAME + ": ",
      React.createElement(
        M.Item.Badge,
        { type: autoSave ? "green" : "red" },
        autoSave ? "On" : "Off"
      )
    ),
    React.createElement(
      M.Item,
      { icon: SAVE_ICON, onSelect: () => void saveScene(false) },
      "Save to " + FILE_NAME
    ),
    React.createElement(M.DefaultItems.LoadScene),
    React.createElement(M.DefaultItems.SaveToActiveFile),
    React.createElement(M.DefaultItems.Export),
    React.createElement(M.DefaultItems.SaveAsImage),
    React.createElement(M.DefaultItems.SearchMenu),
    React.createElement(M.DefaultItems.Help),
    React.createElement(M.DefaultItems.ClearCanvas),
    React.createElement(M.Separator),
    React.createElement(
      M.Group,
      { title: "Excalidraw links" },
      React.createElement(M.DefaultItems.Socials)
    ),
    React.createElement(M.Separator),
    React.createElement(M.DefaultItems.ToggleTheme),
    React.createElement(M.DefaultItems.ChangeCanvasBackground)
  );
}

/**
 * Repeat-arrows glyph for the auto-save toggle (menu items take a JSX icon).
 */
const AUTO_SAVE_ICON = React.createElement(
  "svg",
  {
    width: 15,
    height: 15,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true",
    focusable: "false"
  },
  React.createElement("path", { d: "M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.6-4.2" }),
  React.createElement("path", { d: "M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7.6 4.2" }),
  React.createElement("path", { d: "M21 3v5h-5" }),
  React.createElement("path", { d: "M3 21v-5h5" })
);

/**
 * Push the file's scene into the editor.
 *
 * `excalidrawAPI` fires from Excalidraw's *constructor* (before mount) while
 * `initializeScene()` runs async out of componentDidMount — so an
 * updateScene() made straight away is silently replaced by Excalidraw's own
 * (empty) initialisation. Wait for that to settle, apply, verify the
 * elements actually stuck, and re-apply until they do.
 */
function loadFileScene() {
  let saved = null;
  if (window.__SUWU_SCENE__) {
    try {
      saved = JSON.parse(window.__SUWU_SCENE__);
    } catch (e) {
      status("Load failed: unreadable file");
    }
  }
  if (!saved) {
    ready = true;
    return;
  }
  const scene = {
    elements: Array.isArray(saved.elements) ? saved.elements : [],
    appState: pickAppState(saved.appState),
    files: saved.files,
    commitToHistory: false
  };
  // getSceneElements() drops deleted entries, so count the live ones.
  const want = scene.elements.filter((el) => el && !el.isDeleted).length;
  let tries = 0;
  let lastCount = -1;

  const finish = () => {
    ready = true;
    if (want > 0) status("Loaded " + want + (want === 1 ? " element" : " elements"));
    // Last line of defence: if the canvas is empty once we said we loaded,
    // Excalidraw wiped us after the fact — put the scene back.
    window.setTimeout(() => {
      if (want > 0 && api.getSceneElements().length === 0) {
        try {
          api.updateScene(scene);
        } catch (e) {
          /* nothing else to try */
        }
      }
    }, 600);
  };

  const attempt = () => {
    tries++;
    try {
      api.updateScene(scene);
    } catch (e) {
      ready = true;
      status("Load failed: " + (e && e.message ? e.message : e));
      return;
    }
    // Let Excalidraw's async init run, then check whether it wiped us.
    window.setTimeout(() => {
      const got = api.getSceneElements().length;
      // Every live element is in, or the count stopped moving (Excalidraw
      // dropped a few invalid ones and nothing is overwriting us any more).
      if (want === 0 || got >= want || (tries >= 2 && got === lastCount)) {
        finish();
        return;
      }
      lastCount = got;
      if (tries >= 30) {
        ready = true;
        status("Load failed: scene not applied");
        return;
      }
      attempt();
    }, 200);
  };
  // component-mount + Excalidraw's async initializeScene come first.
  window.setTimeout(attempt, 300);
}

function App() {
  const onSceneReady = React.useCallback((instance) => {
    api = instance;
    if (FILE_PATH) {
      // File-backed tile: the document on disk wins over the pane's scratch
      // store, so an empty file starts blank instead of reviving old state.
      loadFileScene();
      return;
    }
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

  const [autoSave, setAutoSave] = React.useState(autoSaveOn);

  const onToggleAutoSave = React.useCallback(() => {
    autoSaveOn = !autoSaveOn;
    if (autoSaveOn) scheduleAutoSave(); // flush anything edited while it was off
    else window.clearTimeout(autoTimer);
    setAutoSave(autoSaveOn);
    status("Auto save " + (autoSaveOn ? "on" : "off"));
  }, []);

  const onChange = React.useCallback((elements, appState, files) => {
    if (!ready) return;
    if (FILE_PATH && autoSaveOn) scheduleAutoSave();
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

  return React.createElement(
    Excalidraw,
    {
      name: FILE_NAME || "Excalidraw",
      excalidrawAPI: onSceneReady,
      onChange,
      UIOptions: {
        canvasActions: { saveToActiveFile: true }
      }
    },
    buildMainMenu(autoSave, onToggleAutoSave)
  );
}


createRoot(document.getElementById("root")).render(React.createElement(App));
