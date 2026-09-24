/**
 * Note — a simple client-side notepad: seven fixed slots shown as a strip
 * of numbered square chips, with the active note rendered as a flat
 * (non-tilted) 3M Post-it below.
 *
 * Pure client: nothing leaves the browser. The sandboxed frame has no web
 * storage of its own, so the slots are kept in the trusted parent frame's
 * IndexedDB through a scoped postMessage bridge (EXTENSION_TILE_PLAN.md
 * §4.8) — no API, no suwu.net. The render stub ships the shell;
 * public/note.js wires it (a public file — no secrets,
 * docs/EXTENSION_API_PLAN.md §2.8).
 */
function handler() {
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Note</title>
<link rel="stylesheet" href="/gqjs/static/note/style.css">
</head>
<body>
<!-- Left-aligned strip: the tile's top-right corner stays empty. -->
<header class="tabs" id="tabs" role="tablist" aria-label="Notes">
  <button class="tab" type="button" role="tab" data-i="0" aria-selected="true">1</button>
  <button class="tab" type="button" role="tab" data-i="1" aria-selected="false">2</button>
  <button class="tab" type="button" role="tab" data-i="2" aria-selected="false">3</button>
  <button class="tab" type="button" role="tab" data-i="3" aria-selected="false">4</button>
  <button class="tab" type="button" role="tab" data-i="4" aria-selected="false">5</button>
  <button class="tab" type="button" role="tab" data-i="5" aria-selected="false">6</button>
  <button class="tab" type="button" role="tab" data-i="6" aria-selected="false">7</button>
</header>
<main class="postit color-yellow" id="postit" role="tabpanel">
  <textarea id="editor" class="editor" maxlength="1500" aria-label="Note" placeholder="Type a note..."></textarea>
</main>
<p id="status" class="status" role="status"></p>
<script src="/gqjs/static/note/note.js"></script>
</body>
</html>
`,
  };
}
