/**
 * Excalidraw — render stub.
 *
 * The tile's actual UI is a Vite build (`src/` → `dist/`, a normal JS project
 * with npm dependencies). Nothing is loaded from a CDN. This script is the one
 * server-side piece: it reads the build manifest, emits the HTML shell with the
 * hashed entry chunk, and hands the page three runtime values it cannot know
 * itself —
 *
 *   window.__SUWU_FILE__   the document path from ?file= ("" when untitled)
 *   window.__SUWU_SCENE__  that file's contents, read through the /fs mount
 *   window.__SUWU_TOKEN__  this extension's scoped API token
 *
 * Never inline secrets into public/ — dist/ is served unauthenticated. They
 * travel in this authenticated HTML instead (docs/EXTENSION_API_PLAN.md §2.8).
 *
 * The extension root is mounted read-only at /ext, so the manifest is readable
 * without needing suwu.fs; that flag is for the document itself.
 */
function handler(input) {
  const id = (input && input.id) || "excalidraw";
  const token = (input && input.token) || "";
  const file = (input && input.params && input.params.file) || (input && input.query && input.query.file) || "";
  const scene = file ? readDocument(file) : "";
  const build = readBuild(id);
  if (build.error) {
    return {
      status: 500,
      contentType: "text/plain; charset=utf-8",
      body: "excalidraw: " + build.error,
    };
  }
  const injected =
    "<script>" +
    "window.__SUWU_FILE__=" + JSON.stringify(file) + ";" +
    "window.__SUWU_SCENE__=" + JSON.stringify(scene) + ";" +
    "window.__SUWU_TOKEN__=" + JSON.stringify(token) + ";" +
    "</script>";
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: page(id, build, injected),
  };
}

/** Read the mounted document, or "" when it does not exist / cannot be read. */
function readDocument(file) {
  try {
    // The mount exposes exactly the document's directory at /fs.
    return fs.readFileSync("/fs/" + file.split("/").pop());
  } catch (e) {
    return "";
  }
}

/**
 * Resolve the hashed entry chunk.
 *
 * Two layouts are supported, because suwu.static may point at either:
 *   - `dist.zip` (the shipped one): pack-static.mjs reads Vite's manifest and
 *     publishes build.json next to the archive, since the gqjs sandbox cannot
 *     read inside a zip;
 *   - a `dist/` directory (a checkout that only ran `vite build`): the manifest
 *     is read straight off disk.
 *
 * Returns { js, css } or { error }; the server fails the render with that
 * message rather than serving a page that 404s every asset.
 */
function readBuild(id) {
  const root = "/ext/" + id;
  let raw = null;
  try {
    raw = fs.readFileSync(root + "/build.json");
  } catch (e) {
    /* no archive build: fall through to the directory layout */
  }
  if (raw) {
    try {
      const info = JSON.parse(raw);
      if (info && info.js) {
        return { js: info.js, css: Array.isArray(info.css) ? info.css : [] };
      }
    } catch (e) {
      return { error: "unreadable build.json: " + e };
    }
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(root + "/dist/.vite/manifest.json"));
  } catch (e) {
    return { error: "no build found at " + root + " (run: pnpm --dir <extension> build)" };
  }
  let entry = manifest["src/main.js"];
  if (!entry) {
    for (const key in manifest) {
      if (manifest[key] && manifest[key].isEntry) {
        entry = manifest[key];
        break;
      }
    }
  }
  if (!entry || !entry.file) {
    return { error: "build manifest has no entry chunk" };
  }
  return { js: entry.file, css: Array.isArray(entry.css) ? entry.css : [] };
}

/**
 * Absolute asset base, computed in the page.
 *
 * The tile is sandboxed, so `location.origin` is "null" and Excalidraw's
 * `new URL(path, base)` would throw on a relative base — but `location.href` is
 * still the real page URL, so resolving the static path against it gives an
 * absolute URL without the server needing to know its own origin.
 *
 * This runs as a classic inline script in <head>, before the module bundle, so
 * Excalidraw never sees an unset EXCALIDRAW_ASSET_PATH (its font loader would
 * otherwise fall back to the esm.sh CDN, which our CSP blocks).
 */
function assetScript(id) {
  const base = "/gqjs/static/" + encodeURIComponent(id) + "/";
  return (
    "<script>(function(){try{window.EXCALIDRAW_ASSET_PATH=" +
    "new URL(" + JSON.stringify(base) + ",document.location.href).href;" +
    "}catch(e){window.EXCALIDRAW_ASSET_PATH=" + JSON.stringify(base) + ";}})();</script>"
  );
}

/** The HTML shell: build chunks from dist/, nothing from a third party. */
function page(id, build, injected) {
  const base = "/gqjs/static/" + id + "/";
  const css = build.css
    .map(function (f) {
      return '<link rel="stylesheet" href="' + base + f + '">';
    })
    .join("\n");
  return (
    '<!doctype html>\n<html lang="en">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "<title>Excalidraw</title>\n" +
    css + "\n" +
    assetScript(id) + "\n" +
    injected + "\n" +
    "</head>\n<body>\n" +
    '<div id="root"></div>\n' +
    '<div id="suwu-status" aria-live="polite"></div>\n' +
    '<script type="module" src="' + base + build.js + '"></script>\n' +
    "</body>\n</html>\n"
  );
}
