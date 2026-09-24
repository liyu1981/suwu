/**
 * Hacker News Top Stories — render stub.
 *
 * Only what must be server-side lives here: status/contentType plus the
 * authenticated API URL (session token) embedded in the page. Styles and the
 * ES-module app come from the static directory (package.json → suwu.static).
 *
 * NEVER put the token or other secrets into public/ — static files are served
 * unauthenticated because module fetches cannot carry credentials
 * (docs/EXTENSION_API_PLAN.md §2.8). Secrets travel via this HTML: hx-get
 * feeds htmx, data-api feeds the module app.
 */
function handler(input) {
  const token = encodeURIComponent(input.token || "");
  const api =
    "/gqjs/api/" +
    encodeURIComponent(input.id || "hn-top-stories") +
    "/stories?token=" +
    token;
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: stub(api),
  };
}

function stub(api) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Hacker News Daily</title>
<link rel="stylesheet" href="/gqjs/static/hn-top-stories/style.css">
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

  <div id="wire" class="wire" aria-hidden="true"
       data-api="${api}"
       hx-get="${api}"
       hx-trigger="load, every 300s"
       hx-swap="none"></div>
</main>

<script src="https://unpkg.com/htmx.org@2.0.4/dist/htmx.min.js"></script>
<script type="module" src="/gqjs/static/hn-top-stories/app.js"></script>
</body>
</html>
`;
}
