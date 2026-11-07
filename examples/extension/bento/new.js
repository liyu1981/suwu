/**
 * `suwu ext-run bento new [name]` — create a pristine Bento deck.
 *
 * A Bento deck is self-contained: the vendored shell with an EMPTY `#bento-doc`
 * block *is* a new document ("a pristine New shell", in upstream's words). So
 * creating one is copying that shell into the directory the command was pointed
 * at, through the /fs mount that suwu.fs provides.
 *
 *   suwu ext-run bento new deck.bento.html
 *   suwu ext-run --dir ~/decks bento new        # → Untitled.bento.html
 */
const DEFAULT_NAME = "Untitled.bento.html";

function handler(input) {
  const dir = input.dir || "";
  if (!dir) {
    return { status: 400, body: "bento needs suwu.fs to create decks" };
  }
  const name = targetName((input.args && input.args[0]) || DEFAULT_NAME);
  if (!name) {
    return { status: 400, body: "invalid name (use a plain .bento.html file name)" };
  }
  const path = dir + "/" + name;
  if (fs.existsSync(path)) {
    return { status: 409, body: path + " already exists" };
  }
  let shell;
  try {
    shell = fs.readFileSync("/ext/" + (input.id || "bento") + "/dist/shell.html");
  } catch (e) {
    return { status: 500, body: "the vendored shell is missing (run: node vendor.mjs)" };
  }
  try {
    fs.writeFileSync(path, shell);
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

/** A plain file name ending in .bento.html; no directories, no traversal. */
function targetName(raw) {
  let name = String(raw || "").trim();
  if (!name) name = DEFAULT_NAME;
  if (name.indexOf("/") >= 0 || name.indexOf("\\") >= 0) return "";
  if (name === "." || name === ".." || name.charAt(0) === ".") return "";
  if (!/\.bento\.html$/i.test(name)) {
    name = name.replace(/\.html?$/i, "") + ".bento.html";
  }
  return name;
}
