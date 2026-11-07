/**
 * Bento Slides — render stub.
 *
 * The product here is unusual: a `.bento.html` file *is* the application. It
 * carries the deck, the editor, the presenter and every asset in one HTML file,
 * and saving rewrites that file. So the tile does not load a document into an
 * app — it serves the document, which brings its own app.
 *
 * What this stub adds to the deck before serving it:
 *
 *   - the file's own document JSON, spliced into the shell's `#bento-doc` block
 *     (the shell we vendor ships that block empty; a real deck carries it)
 *   - `window.__SUWU` — this tile's file path, scoped API token and static base
 *   - `dist/suwu-host.js`, the host shim that makes ⌘S write back to the server
 *
 * Both injected nodes carry `data-bento-transient`. That attribute is Bento's own
 * convention — `kernel/src/save.ts` clones the live document for serialization
 * and drops every `[data-bento-transient]` node — so the file this tile writes
 * back is a pristine, standalone `.bento.html` with no Suwu references in it.
 *
 * Never inline secrets into dist/: static files are served unauthenticated. The
 * token travels in these injected tags, in this authenticated response only.
 */

/** The shell we vendor (see vendor.mjs). Read through the read-only /ext mount. */
function readShell(id) {
  try {
    return fs.readFileSync("/ext/" + id + "/dist/shell.html");
  } catch (e) {
    return null;
  }
}

/**
 * Pull the document JSON out of a `.bento.html`, and splice one in.
 *
 * The JSON sits in `<script type="application/bento+json" id="bento-doc">…</script>`.
 * Both directions are string surgery on that one block: Suwu never parses or
 * validates the document (Bento's own `window.bento.validate()` does), it only
 * carries the bytes.
 */
const DOC_OPEN = '<script type="application/bento+json" id="bento-doc">';
const DOC_CLOSE = "</script>";

/** Whether the file has the document block at all (empty or not). */
function hasDocBlock(html) {
  const start = html.indexOf(DOC_OPEN);
  if (start < 0) return false;
  return html.indexOf(DOC_CLOSE, start + DOC_OPEN.length) >= 0;
}

/**
 * The deck's document JSON, or "" for a present-but-empty block.
 *
 * Empty is a DOCUMENT, not a defect: upstream's own reader returns "" for a
 * present-but-empty block and calls it "a pristine New shell", distinguishing it
 * from `null` = no block at all. A fresh Bento download is exactly that — open
 * it, it is the editor on a new deck, and the first save writes the document in.
 */
function docFrom(html) {
  const start = html.indexOf(DOC_OPEN);
  if (start < 0) return "";
  const from = start + DOC_OPEN.length;
  const end = html.indexOf(DOC_CLOSE, from);
  if (end < 0) return "";
  return html.slice(from, end).trim();
}

/** The shell with `docJson` in its document block. */
function spliceDoc(shell, docJson) {
  const start = shell.indexOf(DOC_OPEN);
  if (start < 0) return "";
  const from = start + DOC_OPEN.length;
  const end = shell.indexOf(DOC_CLOSE, from);
  if (end < 0) return "";
  return shell.slice(0, from) + docJson + shell.slice(end);
}

/** Read the deck from the document mount (`suwu.fs` exposes its directory at /fs). */
function readDeck(file) {
  const base = file.split("/").pop();
  try {
    return fs.readFileSync("/fs/" + base);
  } catch (e) {
    return null;
  }
}

/**
 * The bootstrap this tile injects, marked transient so a save cannot carry it
 * into the file on disk.
 */
function inject(id, file, token) {
  const cfg = {
    id: id,
    file: file,
    token: token,
    api: "/gqjs/api/" + id + "/",
    static: "/gqjs/static/" + id + "/",
  };
  return (
    '<script data-bento-transient>window.__SUWU=' +
    JSON.stringify(cfg) +
    ";</script>" +
    '<script data-bento-transient src="/gqjs/static/' +
    id +
    '/suwu-host.js"></script>'
  );
}

function handler(input) {
  const id = (input && input.id) || "bento";
  const token = (input && input.token) || "";
  const file = (input && input.params && input.params.file) || (input && input.query && input.query.file) || "";

  const shell = readShell(id);
  if (!shell) {
    return {
      status: 500,
      contentType: "text/plain; charset=utf-8",
      body: id + ": no shell at dist/shell.html (run: node vendor.mjs)",
    };
  }

  // No file: serve the shell as a new deck. Saves then download rather than
  // writing back (the shim), because there is no directory to write into.
  let docJson = "";
  if (file) {
    const deck = readDeck(file);
    if (deck === null) {
      return {
        status: 404,
        contentType: "text/plain; charset=utf-8",
        body: id + ": cannot read " + file,
      };
    }
    if (!hasDocBlock(deck)) {
      // Not a Bento file at all. (An empty block is fine — that is a pristine
      // New deck, see docFrom.)
      return {
        status: 400,
        contentType: "text/plain; charset=utf-8",
        body:
          id +
          ": " +
          file +
          ' is not a Bento deck (no <script type="application/bento+json" ' +
          'id="bento-doc"> block). A fresh Bento shell has an EMPTY block, so ' +
          "this file was made by something else.",
      };
    }
    docJson = docFrom(deck);
  }

  const spliced = spliceDoc(shell, docJson);
  if (!spliced) {
    return {
      status: 500,
      contentType: "text/plain; charset=utf-8",
      body: id + ": dist/shell.html has no bento-doc block",
    };
  }

  // Inject before </head> so the crate config and the shim run before the app's
  // own (deferred) module script.
  const at = spliced.indexOf("</head>");
  const body =
    at < 0
      ? inject(id, file, token) + spliced
      : spliced.slice(0, at) + inject(id, file, token) + spliced.slice(at);

  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: body,
  };
}
