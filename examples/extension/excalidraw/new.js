/**
 * `suwu ext-run excalidraw new [name]` — create an empty Excalidraw document.
 *
 * Writes into the directory the command was pointed at (`--dir`, or the one you
 * ran it in), through the /fs mount that suwu.fs provides. The file is the same
 * shape this extension's save handler writes, so it opens with an empty canvas
 * and a working Save.
 *
 *   suwu ext-run excalidraw new plan.excalidraw
 *   suwu ext-run --dir ~/notes excalidraw new        # → Untitled.excalidraw
 */
const DEFAULT_NAME = "Untitled.excalidraw";

function handler(input) {
  const dir = input.dir || "";
  if (!dir) {
    return { status: 400, body: "excalidraw needs suwu.fs to create documents" };
  }
  const name = targetName((input.args && input.args[0]) || DEFAULT_NAME);
  if (!name) {
    return { status: 400, body: "invalid name (use a plain .excalidraw file name)" };
  }
  const path = dir + "/" + name;
  if (fs.existsSync(path)) {
    // Never clobber a document: creating is not overwriting.
    return { status: 409, body: path + " already exists" };
  }
  const doc = { type: "excalidraw", version: 2, elements: [], appState: {}, files: {} };
  try {
    fs.writeFileSync(path, JSON.stringify(doc));
  } catch (e) {
    return { status: 500, body: "cannot write " + name + ": " + e };
  }
  // Report the real path (input.cwd), not the /fs mount the write went through.
  return { status: 200, contentType: "text/plain; charset=utf-8", body: hostPath(input, name) };
}

/** The path a human would type: the real directory, not the mounted one. */
function hostPath(input, name) {
  const cwd = (input && input.cwd) || "";
  return cwd ? cwd + "/" + name : "/fs/" + name;
}

/** A plain file name ending in .excalidraw; no directories, no traversal. */
function targetName(raw) {
  let name = String(raw || "").trim();
  if (!name) name = DEFAULT_NAME;
  if (name.indexOf("/") >= 0 || name.indexOf("\\") >= 0) return "";
  if (name === "." || name === ".." || name.charAt(0) === ".") return "";
  if (!/\.excalidraw$/i.test(name)) name += ".excalidraw";
  return name;
}
