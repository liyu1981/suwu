// Save handler: writes a whole `.bento.html` back to the document's directory.
//
// Bento's save asks the page for the COMPLETE file (shell + document), so this
// receives an entire deck, not a diff. Two consequences shape the design:
//
//  1. It is big. The extension API caps one request body at 4 MiB, while a deck
//     with a couple of images passes that easily, so the host shim uploads in
//     chunks: each call carries one part, and the call that completes the set
//     assembles, verifies and swaps the file into place.
//  2. It must be atomic. A half-written `.bento.html` is a broken application,
//     not just a broken document: the file carries its own editor. So the parts
//     are joined into a temp file in the target's directory and renamed over it
//     (fs.renameSync), which is atomic on one filesystem.
//
// The injected bootstrap never reaches the disk: those nodes are
// `data-bento-transient`, and Bento drops them when it serializes the document.
//
// Contract (docs/EXTENSION_API_PLAN.md):
//   input  = { action, id, route, path, pathParams, method, query, headers, body }
//   return = { status?, contentType?, headers?, body | bodyB64 }

/** Cap on one assembled deck. Larger than any install limit, small enough to bound a write. */
const MAX_BYTES = 32 << 20;

/**
 * Our own injected nodes are `<script data-bento-transient>`. Bento strips them
 * when it serializes, so a well-behaved save never contains them — but the
 * handler strips them again anyway: the injected block carries this tile's
 * scoped API token, and a token must never be written into a user's document
 * (it would then travel with the file to whoever opens it next).
 */
const TRANSIENT_SCRIPTS = /<script[^>]*data-bento-transient[^>]*>[\s\S]*?<\/script>/gi;

/** One upload may be split into at most this many parts (at 1 MiB, ~64 MiB). */
const MAX_PARTS = 64;

const UPLOAD_RE = /^[A-Za-z0-9_-]{1,40}$/;
const TMP_PREFIX = ".suwu-bento-";

function handler(input) {
  if (input.path !== "/save") return json(404, { error: "not found" });
  if (input.method !== "POST") return json(405, { error: "method not allowed" });

  const file = (input.query && input.query.file) || "";
  const target = targetPath(file);
  if (!target) {
    return json(400, { error: "file must be an absolute path ending in .bento.html" });
  }

  const upload = (input.query && input.query.upload) || "";
  const chunk = text(input.body);
  if (!chunk) return json(400, { error: "empty body" });

  // Single-shot upload (small decks, hand-written requests): one call, done.
  if (!upload) {
    if (chunk.length > MAX_BYTES) return json(413, { error: "document too large" });
    return commit(target, [chunk]);
  }

  // Chunked upload: part files live beside the target, then get joined.
  const index = int(input.query.index);
  const total = int(input.query.total);
  if (!UPLOAD_RE.test(upload) || index === null || total === null) {
    return json(400, { error: "bad upload id or part index" });
  }
  if (total < 1 || total > MAX_PARTS || index < 0 || index >= total) {
    return json(400, { error: "bad part range" });
  }

  const dir = tmpDir(upload);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return json(500, { error: "cannot create upload directory: " + e });
  }
  try {
    fs.writeFileSync(dir + "/" + index, chunk);
  } catch (e) {
    return json(500, { error: "cannot write part " + index + ": " + e });
  }

  // Not the last part: the shim keeps going.
  const parts = collect(dir, total);
  if (parts.length < total) {
    return json(200, { ok: true, pending: true, received: parts.length, total: total });
  }

  const bodies = [];
  for (let i = 0; i < total; i++) {
    try {
      bodies.push(fs.readFileSync(dir + "/" + i));
    } catch (e) {
      return json(500, { error: "part " + i + " vanished: " + e });
    }
  }
  const result = commit(target, bodies);
  cleanup(dir, total);
  return result;
}

/**
 * Join the parts, verify, and rename into place.
 *
 * The target is written through a temp file in the SAME directory so the rename
 * cannot cross a filesystem boundary. `renameSync` is what makes the swap atomic.
 */
function commit(target, bodies) {
  let html = "";
  let bytes = 0;
  for (let i = 0; i < bodies.length; i++) {
    bytes += bodies[i].length;
    if (bytes > MAX_BYTES) return json(413, { error: "document too large" });
    html += bodies[i];
  }
  html = html.replace(TRANSIENT_SCRIPTS, "");
  bytes = html.length;
  if (html.indexOf('id="bento-doc"') < 0) {
    // Refuse to replace a good deck with something that is not one: the file is
    // the application, so a bad write is unrecoverable without a backup.
    return json(400, { error: "not a Bento document (no bento-doc block)" });
  }

  const slash = target.lastIndexOf("/");
  const dir = target.slice(0, slash);
  const base = target.slice(slash + 1);
  const tmp = dir + "/" + TMP_PREFIX + "tmp-" + base;
  try {
    fs.writeFileSync(tmp, html);
    fs.renameSync(tmp, target);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (ignored) {
      /* nothing to clean up */
    }
    return json(500, { error: "cannot write " + base + ": " + e });
  }
  // gqjs strings are UTF-16 code units, so this is a character count, not a byte
  // count: name it honestly rather than round-tripping through an encoder.
  return json(200, { ok: true, chars: bytes });
}

/** A target must be absolute, end in .bento.html, and name one plain file. */
function targetPath(file) {
  if (!file || file.charAt(0) !== "/") return null;
  const base = file.split("/").pop();
  if (!base || !/\.bento\.html$/i.test(base)) return null;
  if (base.indexOf("/") >= 0 || base === "." || base === "..") return null;
  // The mount is the document's own directory, so only the basename is used —
  // a request can never address another directory.
  return "/fs/" + base;
}

function tmpDir(upload) {
  return "/fs/" + TMP_PREFIX + upload;
}

/** Indices of the parts present on disk. */
function collect(dir, total) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  const seen = [];
  for (let i = 0; i < names.length; i++) {
    const n = Number(names[i]);
    if (n >= 0 && n < total && String(n) === names[i]) seen.push(n);
  }
  return seen;
}

function cleanup(dir, total) {
  for (let i = 0; i < total; i++) {
    try {
      fs.unlinkSync(dir + "/" + i);
    } catch (ignored) {
      /* already gone */
    }
  }
  try {
    fs.unlinkSync(dir);
  } catch (ignored) {
    /* leave it; an empty dir is harmless */
  }
}

/** The body as text. Handlers see UTF-8 as `body` and bytes as `bodyB64`. */
function text(body) {
  if (typeof body === "string") return body;
  return "";
}

function int(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return n === Math.floor(n) ? n : null;
}

function json(status, payload) {
  return {
    status: status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(payload),
  };
}
