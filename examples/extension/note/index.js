/**
 * Note — render stub: the Post-it shell only.
 *
 * Nine numbered chips (was seven) over one flat 3M Post-it, a transparent
 * document so the tile shows through, and a format bar that floats over the
 * paper's bottom edge. The top-right corner stays empty — the WM's hover
 * toolbar owns it (suwu-tile-plugin-design §11).
 *
 * Structure notes for public/note.js:
 *   #tabs   — the chip rail, built by the module (nine slots, 1..9)
 *   #editor — the input surface: a transparent <textarea> with the painted
 *             clone above it (z-index 2) and an off-screen a11y mirror
 *   #status — "Saved 2 min ago", or the storage error
 *   #bar    — checklist / indent / B I U S </> / heading
 *
 * Pure client: nothing leaves the browser. The sandboxed frame has no web
 * storage of its own, so slots live in the trusted parent frame's IndexedDB
 * through a scoped postMessage bridge (EXTENSION_TILE_PLAN.md §4.8) — no API,
 * no suwu.net. The render stub ships the shell; public/*.js wires it (public
 * files — no secrets, docs/EXTENSION_API_PLAN.md §2.8).
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
<header class="tabs" id="tabs" role="tablist" aria-label="Notes"></header>

<main class="postit color-yellow" id="postit">
  <div class="editor" id="editor">
    <!-- Screen-reader mirror: real list / checkbox roles, off-screen. -->
    <div class="a11y" id="a11y" role="list" aria-label="Note content"></div>
    <!-- The only input surface. Its glyphs are transparent; the paint layer
         above it carries the same characters with the same metrics. -->
    <textarea id="input" class="input" readonly spellcheck="false"
              aria-label="Note" placeholder="Type a note..."></textarea>
    <!-- .clip is the text viewport: it clips the translated paint layer so a
         scrolled line can never slide under the format bar. -->
    <div class="clip"><div class="layer" id="layer"><div class="paint" id="paint" aria-hidden="true"></div></div></div>
  </div>

  <!-- Empty-state affordance: teaches the checklist without a toolbar tour. -->
  <div class="hint" id="hint" hidden>
    <button type="button" class="hint-btn" data-cmd="todo">+ Checklist</button>
  </div>

  <!-- Format bar: floats over the paper's bottom edge, never the WM's corner. -->
  <nav class="bar" id="bar" aria-label="Format">
    <button type="button" class="tb" data-cmd="todo" aria-pressed="false"
            aria-label="Checklist" title="Checklist (&#8984;&#8679;C)">
      <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2.6"/><path d="M5.2 8.2l2 2 3.6-4.2"/></svg>
    </button>
    <span class="sep" aria-hidden="true"></span>
    <button type="button" class="tb" data-cmd="outdent" aria-label="Outdent" title="Outdent (&#8679;Tab)">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.6 4h7"/><path d="M6.6 12h7"/><path d="M2.4 8h3.4"/><path d="M4.2 5.8L2.2 8l2 2.2"/></svg>
    </button>
    <button type="button" class="tb" data-cmd="indent" aria-label="Indent" title="Indent (Tab)">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.6 4h7"/><path d="M6.6 12h7"/><path d="M2.4 8h3.4"/><path d="M4.2 5.8l2 2-2 2.2"/></svg>
    </button>
    <span class="sep" aria-hidden="true"></span>
    <button type="button" class="tb" data-cmd="b" aria-pressed="false" aria-label="Bold" title="Bold (&#8984;B)">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.6 3.4h3.9a2.4 2.4 0 0 1 0 4.8H4.6z"/><path d="M4.6 8.2h4.4a2.3 2.3 0 0 1 0 4.6H4.6z"/></svg>
    </button>
    <button type="button" class="tb" data-cmd="i" aria-pressed="false" aria-label="Italic" title="Italic (&#8984;I)">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.6 3.4H7.2"/><path d="M8.8 12.6H5.4"/><path d="M9.9 3.4L6.1 12.6"/></svg>
    </button>
    <button type="button" class="tb" data-cmd="u" aria-pressed="false" aria-label="Underline" title="Underline (&#8984;U)">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.4 3v4.4a3.6 3.6 0 0 0 7.2 0V3"/><path d="M3.8 13.4h8.4"/></svg>
    </button>
    <button type="button" class="tb" data-cmd="s" aria-pressed="false" aria-label="Strikethrough" title="Strikethrough (&#8984;&#8679;X)">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.8 8h10.4"/><path d="M5.6 5.3A2.6 2.6 0 0 1 8 4.2c1.6 0 2.7.8 2.9 2"/><path d="M10.4 10.6c-.2 1.3-1.3 2.1-2.6 2.1-1.4 0-2.5-.7-2.8-1.8"/></svg>
    </button>
    <button type="button" class="tb mono" data-cmd="c" aria-pressed="false" aria-label="Monospace" title="Monospace (&#8984;&#8679;M)"><span aria-hidden="true">&lt;/&gt;</span></button>
    <span class="sep" aria-hidden="true"></span>
    <button type="button" class="tb" data-cmd="head" aria-pressed="false" aria-label="Heading" title="Heading (&#8984;&#8679;H)">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.6 12.6V3.4"/><path d="M9.8 12.6V3.4"/><path d="M3.6 8h6.2"/></svg>
    </button>
  </nav>
</main>

<p id="status" class="status" role="status"></p>
<script type="module" src="/gqjs/static/note/note.js"></script>
</body>
</html>
`,
  };
}
