/**
 * Hacker News Top Stories — render stub.
 *
 * Only what must be server-side lives here: status/contentType plus the
 * authenticated API URL (extension-scoped token, never the session token)
 * embedded in the page. Styles and the client come from the Vite build in
 * dist/ (package.json → suwu.static).
 *
 * NEVER put the token or other secrets into dist/ — static files are served
 * unauthenticated because module fetches cannot carry credentials
 * (docs/EXTENSION_API_PLAN.md §2.8). Secrets travel via this HTML: the
 * #wire element's data-api feeds the bundled client, which polls the extension
 * API itself — no CDN, no third-party script.
 */
function handler(input) {
  const id = input.id || "hn-top-stories";
  const token = encodeURIComponent(input.token || "");
  const api =
    "/gqjs/api/" + encodeURIComponent(id) + "/stories?token=" + token;
  const build = readBuild(id);
  if (build.error) {
    return { status: 500, contentType: "text/plain; charset=utf-8", body: id + ": " + build.error };
  }
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: stub(api, id, build),
  };
}

/**
 * Resolve the hashed entry chunk from Vite's manifest.
 *
 * The manifest is read off disk through the extension mount, which works because
 * this extension's suwu.static is a *directory*. (An archive source cannot be
 * read from the gqjs sandbox, which is why the zipped example publishes a
 * build.json instead — see ../excalidraw/index.js.)
 */
function readBuild(id) {
  const dir = "/ext/" + id + "/dist";
  let raw;
  try {
    raw = fs.readFileSync(dir + "/.vite/manifest.json");
  } catch (e) {
    return { error: "no build found at " + dir + " (run: pnpm --dir <extension> build)" };
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    return { error: "unreadable build manifest: " + e };
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

function stub(api, id, build) {
  const base = "/gqjs/static/" + id + "/";
  const css = build.css
    .map(function (f) {
      return '<link rel="stylesheet" href="' + base + f + '">';
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Hacker News Daily</title>
${css}
</head>
<body>
<main class="paper">
  <header class="masthead">
    <h1>The Hacker News Daily</h1>
    <div class="dateline">
      <span id="edition-date">&nbsp;</span>
      <span id="edition-page">Page 0 of 0</span>
      <span id="edition-updated">Awaiting dispatch</span>
    </div>
  </header>

  <section id="lead" class="lead" aria-live="polite">
    <p class="status">Awaiting dispatch from the wire&hellip;</p>
  </section>

  <nav class="controls" aria-label="Carousel controls">
    <button id="prev" class="ctl" type="button" disabled>&#9664; Back</button>
    <span id="counter" class="counter">&mdash; / &mdash;</span>
    <button id="next" class="ctl" type="button" disabled>Next &#9654;</button>
  </nav>

  <h2 class="rundown-title">Also in this edition</h2>
  <ol id="rundown" class="rundown"></ol>

  <p class="colophon">
    Front-page data from Hacker News &middot; Served by the Suwu extension API
  </p>

  <div id="wire" class="wire" aria-hidden="true" data-api="${api}"></div>
</main>

<script type="module" src="${base}${build.js}"></script>
</body>
</html>
`;
}
