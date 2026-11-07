"""Author the Suwu pitch deck as bento/slides JSON.

Layout rules come from bento.page/agents.md: 1280x720 canvas, 96px margins,
right-most x <= 1184, title band y72 h84, content from y208.
"""
import json

W, H = 1280, 720
BG = "#0B0E13"
FG = "#F2F4F7"
MUTED = "#98A2B3"
DIM = "#6B7480"
ACCENT = "#7CC6FF"
CARD = "rgba(255,255,255,0.045)"
CARD_LINE = "rgba(255,255,255,0.09)"
MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
SANS = "system-ui, -apple-system, 'Segoe UI', sans-serif"

def text(eid, x, y, w, h, html, size, weight=400, color=FG, align="left",
         valign="top", lh=1.25, role=None, family=SANS, fx=None, ls=None):
    el = {"id": eid, "type": "text", "x": x, "y": y, "w": w, "h": h,
          "rotation": 0, "opacity": 1, "html": html, "fontSize": size,
          "fontFamily": family, "fontWeight": weight, "color": color,
          "align": align, "valign": valign, "lineHeight": lh}
    if role: el["role"] = role
    if ls is not None: el["letterSpacing"] = ls
    if fx: el["fx"] = fx
    return el

def rect(eid, x, y, w, h, fill, stroke="none", sw=0, radius=0, fx=None, link=None, gradient=None):
    el = {"id": eid, "type": "shape", "shape": "rect", "x": x, "y": y, "w": w, "h": h,
          "fill": fill, "stroke": stroke, "strokeWidth": sw, "radius": radius,
          "rotation": 0, "opacity": 1}
    if fx: el["fx"] = fx
    if link: el["link"] = link
    if gradient: el["fillGradient"] = gradient
    return el

def ellipse(eid, x, y, w, h, fill, stroke="none", sw=0, fx=None, link=None, opacity=1):
    el = {"id": eid, "type": "shape", "shape": "ellipse", "x": x, "y": y, "w": w, "h": h,
          "fill": fill, "stroke": stroke, "strokeWidth": sw, "radius": 0,
          "rotation": 0, "opacity": opacity}
    if fx: el["fx"] = fx
    if link: el["link"] = link
    return el

def line(eid, x, y, w, h, color, frm=None, to=None, style="dashed", sw=2, fx=None):
    el = {"id": eid, "type": "shape", "shape": "line", "x": x, "y": y, "w": w, "h": h,
          "fill": color, "stroke": color, "strokeWidth": sw, "strokeStyle": style,
          "radius": 0, "rotation": 0, "opacity": 1,
          "lineStart": "none", "lineEnd": "arrow"}
    if frm: el["from"] = frm
    if to: el["to"] = to
    if fx: el["fx"] = fx
    return el

enter = lambda order=0: {"enter": "fade-up", "order": order}

# ── shared chrome: ids carried across slides so they morph in place ───────────
def chrome(section, page_bar, bar_x=96, bar_y=64, bar_w=64, bar_h=6):
    return [
        text("kicker", 176, 56, 720, 26, section, 18, 600, ACCENT, lh=1.0, role="kicker", ls=2),
        rect("bar", bar_x, bar_y, bar_w, bar_h, ACCENT, radius=3),
        text("foot", 96, 666, 420, 22, "{{page}} / {{pages}}", 16, 500, DIM, lh=1.0),
    ]

def title(html, y=72, h=84, size=44):
    return text("title", 96, y, 1088, h, html, size, 800, FG, lh=1.05, role="title")

slides = []

# ── 1. cover ─────────────────────────────────────────────────────────────────
slides.append({
    "id": "s1", "background": BG, "transition": "none",
    "notes": "Suwu: a browser terminal that grew into a workspace. One Go binary "
             "serves the UI, the shell and every tile. Say what it is in one line, "
             "then move — the deck is short on purpose.",
    "elements": [
        text("kicker", 96, 96, 600, 26, "SUWU  ·  v0.1.16", 18, 600, ACCENT, lh=1.0, role="kicker", ls=3),
        text("headline", 96, 168, 1010, 300, "Every tool you use,<br/>in one browser tab.", 92, 800, FG, lh=1.04, role="title"),
        rect("bar", 96, 498, 380, 12, ACCENT, radius=6),
        text("sub", 96, 540, 780, 90, "A terminal, a file browser, a git graph, an editor, a "
             "whiteboard — tiled, on your own machine, no cloud in the loop.", 26, 400, MUTED, lh=1.35, role="subtitle"),
        # ambient motion: a slow orbit behind the title, the cover's one moving part
        ellipse("orbit", 1046, 132, 132, 132, "rgba(0,0,0,0)", ACCENT, 2, opacity=0.5,
                fx={"loop": {"type": "motion-path", "path": "M0,0 C40,-30 90,30 130,0 C90,40 40,-20 0,0", "duration": 18, "ease": "none"}}),
        text("credits", 96, 640, 700, 22, "github.com/liyu1981/suwu", 16, 500, DIM, lh=1.0),
    ],
})

# ── 2. the problem ───────────────────────────────────────────────────────────
cards = [
    ("c1", 96, "Three tabs, three logins", "Terminal here, editor there, that PDF in a third window. Context switches are the tax nobody budgets for."),
    ("c2", 470, "Your data went to someone else", "Cloud IDEs are convenient and rented. Your files, your keys and your history live on a server whose bill you do not see."),
    ("c3", 844, "Nothing survives a refresh", "The shell dies with the tab. Scrollback, running jobs, the state of your workspace — gone, and you rebuild it by hand."),
]
slides.append({
    "id": "s2", "background": BG, "transition": "morph",
    "notes": "Three familiar pains. Do not read the cards; name them, then say the "
             "next slide is the answer. The bar and the kicker glide in from the cover — "
             "that is the deck's running chrome.",
    "elements": chrome("THE PROBLEM", 64)[:2] + [title("The tab is not a workspace.")] + [
        rect(cid, x, 236, 340, 320, CARD, CARD_LINE, 1, 18) for cid, x, _a, _b in cards
    ] + [
        text(cid + "-h", x + 24, 264, 292, 66, a, 24, 700, FG, lh=1.2) for cid, x, a, _b in cards
    ] + [
        text(cid + "-b", x + 24, 344, 292, 190, b, 18, 400, MUTED, lh=1.45) for cid, x, _a, b in cards
    ] + [
        text("foot", 96, 666, 420, 22, "{{page}} / {{pages}}", 16, 500, DIM, lh=1.0),
    ],
})

# ── 3. architecture (diagram with live connectors) ───────────────────────────

slides.append({
    "id": "s3", "background": BG, "transition": "morph",
    "notes": "One process. The browser is a client, not the owner: sessions live in the "
             "Go server, so a refresh reattaches instead of restarting. The dashes march "
             "along the arrows to say 'traffic'. Click the PTY box to drill in.",
    "elements": chrome("ARCHITECTURE", 64)[:2] + [title("One binary, one socket, no cloud.")] + [
        rect("box-browser", 96, 244, 340, 132, CARD, "rgba(255,255,255,0.12)", 1, 16),
        rect("box-server", 470, 244, 340, 132, CARD, "rgba(255,255,255,0.12)", 1, 16),
        rect("box-pty", 844, 244, 340, 132, "rgba(124,198,255,0.08)", "rgba(124,198,255,0.45)", 1, 16),
    ] + [
        text("lbl-browser", 120, 268, 292, 34, "Browser", 24, 700, FG, lh=1.1),
        text("sub-browser", 120, 306, 292, 56, "React + Vite tile window manager; every pane is an iframe", 16, 400, MUTED, lh=1.4),
        text("lbl-server", 494, 268, 292, 34, "Go server", 24, 700, FG, lh=1.1),
        text("sub-server", 494, 306, 292, 56, "HTTP + WebSocket, auth, files, git, extensions", 16, 400, MUTED, lh=1.4),
        text("lbl-pty", 868, 268, 292, 34, "PTY sessions", 24, 700, ACCENT, lh=1.1),
        text("sub-pty", 868, 306, 292, 56, "libghostty-vt screen state, reattached on refresh  →", 16, 400, MUTED, lh=1.4),
        # Transparent hit target ON TOP of the card: the texts above would
        # otherwise swallow the click (bento.page/agents.md: "give clickable
        # things a padded transparent rect as the hit target, not the text").
        rect("hit-pty", 844, 244, 340, 132, "rgba(0,0,0,0)", "none", 0, 16, link="state-pty"),
    ] + [
        line("arrow-1", 440, 308, 26, 4, ACCENT, {"el": "box-browser", "side": "right"}, {"el": "box-server", "side": "left"},
             fx={"loop": {"type": "dash-march", "distance": 14, "duration": 1.6}}),
        line("arrow-2", 814, 308, 26, 4, ACCENT, {"el": "box-server", "side": "right"}, {"el": "box-pty", "side": "left"},
             fx={"loop": {"type": "dash-march", "distance": 14, "duration": 1.6}}),
    ] + [
        text("arch-note", 96, 424, 1088, 120,
             "Your projects, your shell and every tile talk to the same local process. "
             "Nothing leaves the machine unless you point it at something that does.",
             22, 400, MUTED, lh=1.5),
        text("foot", 96, 666, 420, 22, "{{page}} / {{pages}}", 16, 500, DIM, lh=1.0),
    ],
})

# ── 4. tiles (morphs the architecture boxes into a layout) ───────────────────
slides.append({
    "id": "s4", "background": BG, "transition": "morph",
    "notes": "The previous slide's three boxes rearrange themselves into a workspace. "
             "That is the whole idea: the diagram and the UI are the same thing. "
             "Spaces give you several of these layouts and you switch with a keystroke.",
    "elements": chrome("TILES & SPACES", 64)[:2] + [title("Everything is a tile.")] + [
        rect("box-browser", 96, 208, 528, 176, CARD, CARD_LINE, 1, 16),
        rect("box-server", 656, 208, 528, 176, CARD, CARD_LINE, 1, 16),
        rect("box-pty", 96, 400, 528, 176, CARD, CARD_LINE, 1, 16),
        rect("box-notes", 656, 400, 528, 176, CARD, CARD_LINE, 1, 16),
    ] + [
        text("lbl-t1", 124, 232, 470, 34, "Terminal", 24, 700, FG, lh=1.1),
        text("sub-t1", 124, 272, 470, 96, "Split it, move it, pull it into focus mode. Sessions keep running while you shuffle.", 17, 400, MUTED, lh=1.45),
        text("lbl-t2", 684, 232, 470, 34, "Editor", 24, 700, FG, lh=1.1),
        text("sub-t2", 684, 272, 470, 96, "Code explorer with ranges, search and save — next to the shell that runs it.", 17, 400, MUTED, lh=1.45),
        text("lbl-t3", 124, 424, 470, 34, "Documents", 24, 700, FG, lh=1.1),
        text("sub-t3", 124, 464, 470, 96, "A whiteboard, a deck, a note: extension tiles that open and save real files.", 17, 400, MUTED, lh=1.45),
        text("lbl-t4", 684, 424, 470, 34, "Browsers", 24, 700, FG, lh=1.1),
        text("sub-t4", 684, 464, 470, 96, "Files, git history, a static preview, a port forward — same tiling, same shortcuts.", 17, 400, MUTED, lh=1.45),
        text("spaces-note", 96, 600, 1088, 60,
             "Spaces keep several layouts at once — a debugging space, a writing space — and "
             "switching between them is one keystroke.", 18, 400, MUTED, lh=1.45),
        text("foot", 96, 666, 420, 22, "{{page}} / {{pages}}", 16, 500, DIM, lh=1.0),
    ],
})

# ── 5. extensions table ─────────────────────────────────────────────────────
row = lambda *cells: {"cells": [{"html": c} if isinstance(c, str) else c for c in cells]}
slides.append({
    "id": "s5", "background": BG, "transition": "fade",
    "notes": "One manifest explains the whole extension story: what it claims, how it "
             "is packaged, what it needs. Packaging is a spectrum — plain folder, single "
             "bundle, archive — pick the lightest that fits.",
    "elements": chrome("EXTENSIONS", 64)[:2] + [title("Extensions are just files with a manifest.")] + [
        {"id": "tbl", "type": "table", "x": 96, "y": 220, "w": 1088, "h": 348, "rotation": 0, "opacity": 1,
         "header": True,
         "columns": [{"w": 1.5}, {"w": 1.05}, {"w": 1.45}],
         "rows": [
             row("Extension", "Claims", "Packaging"),
             row("excalidraw", ".excalidraw", "Vite build → dist.zip (one blob)"),
             row("bento", ".bento.html", "vendored shell, saved by the app itself"),
             row("note", "—", "single bundle in dist/"),
             row("hn-top-stories", "—", "single bundle + server-side crawl"),
             row("eye", "—", "a plain folder, no build"),
         ],
         "style": {"headerBg": "#161B22", "headerColor": FG, "zebra": "rgba(255,255,255,0.03)",
                   "borderColor": "rgba(255,255,255,0.08)", "borderWidth": 1,
                   "cellPadX": 16, "cellPadY": 12, "fontSize": 18, "color": "#D7DBE0", "radius": 12}},
        text("ext-note", 96, 588, 1088, 60,
             "A tile can also claim a file type: <b>suwu open plan.excalidraw</b> lands in the whiteboard, "
             "and edits save straight back to that path.", 18, 400, MUTED, lh=1.45),
        text("foot", 96, 666, 420, 22, "{{page}} / {{pages}}", 16, 500, DIM, lh=1.0),
    ],
})

# ── 6. chart ────────────────────────────────────────────────────────────────
slides.append({
    "id": "s6", "background": BG, "transition": "fade",
    "notes": "Measured, not estimated: the app shell and the whiteboard extension. "
             "gzip plus a single archive took most of the wire cost out. If asked why "
             "not one bundle everywhere: two use cases, two packagings.",
    "elements": chrome("WHAT IT COSTS", 64)[:2] + [title("Smaller on the wire, same on screen.")] + [
        text("big", 96, 236, 300, 130, "74%", 104, 800, ACCENT, lh=1.0, fx={"countUp": True}),
        text("big-cap", 96, 372, 300, 90, "smaller app shell<br/>with gzip", 22, 400, MUTED, lh=1.4),
        {"id": "chart", "type": "chart", "x": 430, "y": 216, "w": 754, "h": 396, "rotation": 0, "opacity": 1,
         "preset": "bar",
         "option": {
             "color": [ACCENT, "#3B4A5A"],
             "grid": {"left": 88, "right": 24, "top": 48, "bottom": 40},
             "legend": {"show": True, "top": 0, "textStyle": {"fontSize": 15, "fontWeight": 600}},
             "tooltip": {"trigger": "item", "formatter": "{b}: {c} MB"},
             "xAxis": {"type": "category", "data": ["App shell", "Excalidraw extension"],
                       "axisLabel": {"fontSize": 15, "color": MUTED},
                       "axisLine": {"lineStyle": {"color": "rgba(255,255,255,0.2)"}},
                       "splitLine": {"show": False}},
             "yAxis": {"type": "value", "min": 0, "max": 25,
                       "axisLabel": {"fontSize": 14, "color": MUTED, "formatter": "{value}"},
                       "splitLine": {"lineStyle": {"color": "rgba(255,255,255,0.08)"}}},
             "series": [
                 {"type": "bar", "name": "before", "data": [5.71, 20.2],
                  "itemStyle": {"color": "#3B4A5A", "borderRadius": 4}, "barWidth": 64},
                 {"type": "bar", "name": "now", "data": [1.50, 15.1],
                  "itemStyle": {"color": ACCENT, "borderRadius": 4}, "barWidth": 64},
             ]},
         "fx": {"enter": "fade-up", "order": 1}},
        text("chart-note", 430, 616, 754, 30, "MB on the wire · gzip for the shell, one archive for the extension",
             15, 400, DIM, lh=1.2),
        text("foot", 96, 666, 420, 22, "{{page}} / {{pages}}", 16, 500, DIM, lh=1.0),
    ],
})

# ── 7. state slide: PTY drill-down ──────────────────────────────────────────
slides.append({
    "id": "state-pty", "stateOf": "s3", "transition": "morph", "name": "PTY",
    "background": BG,
    "notes": "Reached by clicking the PTY box. The point: the browser is disposable. "
             "Click anywhere or press ← to go back.",
    "elements": [
        rect("dismiss", 0, 0, W, H, "rgba(0,0,0,0)", "none", 0, 0, link="s3"),
        text("pty-kicker", 96, 120, 700, 26, "DRILL-DOWN  ·  SESSIONS", 18, 600, ACCENT, lh=1.0, ls=2),
        text("pty-title", 96, 168, 1088, 150, "The shell outlives the tab.", 64, 800, FG, lh=1.1, role="title"),
        text("pty-body", 96, 340, 620, 230,
             "Every terminal pane is a real PTY in the server, with its screen held by "
             "libghostty-vt. Close the laptop, reopen the browser, and the same shell is "
             "there — scrollback, running build and all. No tmux ceremony, no reattach "
             "dance: the refresh <i>is</i> the reattach.", 22, 400, MUTED, lh=1.55),
        rect("pty-card", 760, 340, 424, 230, CARD, "rgba(124,198,255,0.35)", 1, 16),
        text("pty-card-h", 784, 364, 376, 30, "Also free", 20, 700, ACCENT, lh=1.1),
        text("pty-card-b", 784, 402, 376, 150,
             "Per-pane font and theme · a frequent-input shelf with saved snippets · "
             "split, focus and swap shortcuts.", 18, 400, MUTED, lh=1.5),
        text("pty-back", 96, 620, 700, 26, "←  click anywhere to return", 16, 500, DIM, lh=1.0),
    ],
})

# ── 8. terminal detail ──────────────────────────────────────────────────────
term_lines = [
    ("$ ", "suwu serve", ACCENT, FG),
    ("", "  https://pvedev:8181  ·  PTY sessions ready", DIM, MUTED),
    ("$ ", "suwu open plan.excalidraw", ACCENT, FG),
    ("", "  → whiteboard tile, editing the file on disk", DIM, MUTED),
    ("$ ", "suwu ext-run bento new deck.bento.html", ACCENT, FG),
    ("", "  → /home/you/decks/deck.bento.html", DIM, MUTED),
    ("$ ", "suwu install --local examples/extension/bento", ACCENT, FG),
    ("", "  ✅ 6 files, 15 MB  ·  node_modules/src skipped", DIM, MUTED),
]
slides.append({
    "id": "s7", "background": BG, "transition": "fade",
    "notes": "The CLI is a first-class surface, not an afterthought: open, diff, code, "
             "gitgraph, forward, install, ext-run. Show the four you would actually type.",
    "elements": chrome("THE CLI", 64)[:2] + [title("The terminal is where you start.")] + [
        text("cli-body", 96, 232, 500, 300,
             "Open files, diffs and graphs from the shell you are already in. Install an "
             "extension from a checkout, then create a document with it — the same verbs "
             "the UI uses, scriptable and pipeable.", 22, 400, MUTED, lh=1.55),
        rect("term", 628, 216, 556, 392, "#05070A", "rgba(255,255,255,0.1)", 1, 14),
        rect("term-bar", 628, 216, 556, 34, "rgba(255,255,255,0.05)", "none", 0, 14),
        ellipse("dot1", 646, 228, 10, 10, "#FF5F57"),
        ellipse("dot2", 662, 228, 10, 10, "#FEBC2E"),
        ellipse("dot3", 678, 228, 10, 10, "#28C840"),
    ] + [
        text(f"ln{i}", 648, 266 + i * 40, 520, 40, f'<span>{p}{c}</span>', 17, 500, col, lh=1.3, family=MONO)
        for i, (p, c, col, _) in enumerate(term_lines)
    ] + [
        text("foot", 96, 666, 420, 22, "{{page}} / {{pages}}", 16, 500, DIM, lh=1.0),
    ],
})

# ── 9. closing (morphs the cover back) ──────────────────────────────────────
slides.append({
    "id": "s8", "background": BG, "transition": "morph",
    "notes": "Close on the promise, not a feature list. Offer the one command, then stop "
             "talking and answer questions.",
    "elements": [
        text("kicker", 96, 96, 600, 26, "SUWU  ·  v0.1.16", 18, 600, ACCENT, lh=1.0, role="kicker", ls=3),
        text("headline", 96, 160, 1010, 292, "Your machine.<br/>Your files.<br/>One tab.", 88, 800, FG, lh=1.04, role="title"),
        rect("bar", 96, 468, 380, 12, ACCENT, radius=6),
        text("cta", 96, 500, 780, 84,
             "Install the binary, open the port, keep your data where it already is.", 26, 400, MUTED, lh=1.35, role="subtitle"),
        rect("cmd", 96, 596, 1000, 52, "rgba(124,198,255,0.08)", "rgba(124,198,255,0.35)", 1, 10),
        text("cmd-text", 116, 608, 960, 30,
             "curl -fsSL https://raw.githubusercontent.com/liyu1981/suwu/refs/heads/master/install.sh | sh",
             16, 600, ACCENT, lh=1.0, family=MONO),
        ellipse("orbit", 1046, 300, 132, 132, "rgba(0,0,0,0)", ACCENT, 2, opacity=0.5,
                fx={"loop": {"type": "motion-path", "path": "M0,0 C40,-30 90,30 130,0 C90,40 40,-20 0,0", "duration": 18, "ease": "none"}}),
    ],
})

# ── 10. hidden appendix ─────────────────────────────────────────────────────
slides.append({
    "id": "s9", "hidden": True, "background": BG, "transition": "fade",
    "notes": "Only if someone asks how the deck was made — it is the same story as the "
             "product: an extension, a file, a command.",
    "elements": chrome("APPENDIX", 64)[:2] + [title("How this deck was made.")] + [
        text("a1", 96, 232, 1088, 60,
             "<b>1.</b>  suwu ext-run bento new suwu.bento.html   ← a blank deck, created by the Bento extension itself",
             19, 400, MUTED, lh=1.4, family=SANS),
        text("a2", 96, 296, 1088, 60,
             "<b>2.</b>  the #bento-doc JSON block was written in place — no editor, no export step",
             19, 400, MUTED, lh=1.4),
        text("a3", 96, 360, 1088, 60,
             "<b>3.</b>  suwu open suwu.bento.html   ← the deck opens in a tile; ⌘S writes it back with Bento's own save",
             19, 400, MUTED, lh=1.4),
        text("a4", 96, 424, 1088, 60,
             "<b>4.</b>  the file is self-contained: fonts, renderer and presenter travel with it",
             19, 400, MUTED, lh=1.4),
        text("foot", 96, 666, 420, 22, "{{page}} / {{pages}}", 16, 500, DIM, lh=1.0),
    ],
})

doc = {
    "format": "bento/slides", "version": 1,
    "title": "Suwu — every tool, one tab",
    "size": {"width": W, "height": H},
    "theme": {"background": BG, "color": FG, "accent": ACCENT, "fontFamily": SANS},
    "meta": {"author": "Suwu", "company": "Suwu", "subject": "Browser terminal workspace"},
    "slides": slides,
}

# Escape every "<" so the block can never contain a literal </script>.
out = json.dumps(doc, indent=1, ensure_ascii=False).replace("<", "\\u003c")
open("/tmp/suwu-deck.json", "w", encoding="utf-8").write(out)

# ── self-checks against the guide's rules ───────────────────────────────────
ids_seen, problems = set(), []
for s in slides:
    per = [e["id"] for e in s["elements"]]
    if len(per) != len(set(per)):
        problems.append(f"{s['id']}: duplicate element id")
    for e in s["elements"]:
        if e["type"] == "text" and not e.get("html"):
            problems.append(f"{s['id']}/{e['id']}: empty text")
        full_bleed = e["x"] == 0 and e["w"] == W
        if e["x"] + e["w"] > 1184 and e["x"] > 0 and not full_bleed:
            problems.append(f"{s['id']}/{e['id']}: right edge {e['x']+e['w']} > 1184")
        if e["y"] + e["h"] > 700 and e["id"] not in ("foot",) and not full_bleed:
            problems.append(f"{s['id']}/{e['id']}: bottom {e['y']+e['h']} > 700")
    ids_seen.add(s["id"])
for s in slides:
    for e in s["elements"]:
        if "link" in e and e["link"] not in ids_seen:
            problems.append(f"{s['id']}/{e['id']}: link to unknown slide {e['link']}")
print("slides:", len(slides), "| elements:", sum(len(s["elements"]) for s in slides))
print("problems:", problems or "none")
print("json bytes:", len(out))
