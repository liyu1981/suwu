#!/usr/bin/env python3
"""
Build doc pages from templates + content files.

All links use absolute paths from the website root (/).
"""

import os

DOCDIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATEDIR = os.path.join(DOCDIR, "templates")
CONTENTDIR = os.path.join(DOCDIR, "pages")

# ── Page definitions ────────────────────────────────────────────────────────
# url:      absolute URL path from website root
# title:    <title> and doc-header h1
# lead:     doc-header .doc-lead text
# breadcrumb: last crumb text
# active:   which sidebar link gets aria-current="page"
# prev/next: (url, label, title) tuples

PAGES = [
    {
        "url": "/docs/get-started.html",
        "title": "Get Started — Suwu Docs",
        "description": "Install Suwu and get your first terminal running in under a minute.",
        "lead": "Install Suwu and get your first terminal running in under a minute.",
        "breadcrumb": "Get Started",
        "active": "get-started",
        "prev": ("/docs/index.html", "← Back", "Docs Index"),
        "next": ("/docs/features/tiling-wm.html", "Next →", "Tiling Window Manager"),
    },
    {
        "url": "/docs/upgrading.html",
        "title": "Upgrading — Suwu Docs",
        "description": "Update Suwu to the latest version and manage configuration.",
        "lead": "Keep Suwu current with <code>suwu update</code>. The updater handles download, verification, and restart.",
        "breadcrumb": "Upgrading",
        "active": "upgrading",
        "prev": ("/docs/get-started.html", "← Previous", "Get Started"),
        "next": ("/docs/security-data.html", "Next →", "Security &amp; Data"),
    },
    {
        "url": "/docs/security-data.html",
        "title": "Security &amp; Data — Suwu Docs",
        "description": "Where Suwu stores data, security considerations, and intranet usage guidance.",
        "lead": "Where Suwu stores your data, what it has access to, and important security considerations.",
        "breadcrumb": "Security &amp; Data",
        "active": "security-data",
        "prev": ("/docs/upgrading.html", "← Previous", "Upgrading"),
        "next": ("/docs/features/tiling-wm.html", "Next →", "Tiling Window Manager"),
    },
    {
        "url": "/docs/features/tiling-wm.html",
        "title": "Tiling Window Manager — Suwu Docs",
        "description": "Split, focus, move, and swap tiles with keyboard or mouse.",
        "lead": "Split, focus, move, and swap tiles with fast key bindings or a click and drag. Your sessions live in the layout — refresh, disconnect, come back tomorrow, every tile comes back exactly as you left it.",
        "breadcrumb": "Tiling Window Manager",
        "active": "tiling-wm",
        "prev": ("/docs/index.html", "← Back", "Docs Index"),
        "next": ("/docs/features/terminals.html", "Next →", "Terminals"),
    },
    {
        "url": "/docs/features/terminals.html",
        "title": "Terminals — Suwu Docs",
        "description": "Full-featured shells with selection, copy/paste, scrollback, and notifications.",
        "lead": "Real shells with selection, copy/paste, scrollback, and notifications — comfortable for you, and a solid target for agent orchestrators.",
        "breadcrumb": "Terminals",
        "active": "terminals",
        "prev": ("/docs/features/tiling-wm.html", "← Previous", "Tiling Window Manager"),
        "next": ("/docs/features/security.html", "Next →", "Security &amp; Access"),
    },
    {
        "url": "/docs/features/security.html",
        "title": "Security &amp; Access — Suwu Docs",
        "description": "Password authentication, per-run tokens, and one-command HTTPS.",
        "lead": "Access works out of the box on localhost, your LAN, or over the internet behind a reverse proxy — with password authentication, per-run tokens, and one-command HTTPS.",
        "breadcrumb": "Security &amp; Access",
        "active": "security",
        "prev": ("/docs/features/terminals.html", "← Previous", "Terminals"),
        "next": ("/docs/features/file-browser.html", "Next →", "File Browser"),
    },
    {
        "url": "/docs/features/file-browser.html",
        "title": "File Browser — Suwu Docs",
        "description": "Navigate directories, download files, and open the file viewer.",
        "lead": "Navigate directories, download files, and open the file viewer — the small tools you'd otherwise reach for a second terminal or a GUI client, right in the grid next to your shells.",
        "breadcrumb": "File Browser",
        "active": "file-browser",
        "prev": ("/docs/features/security.html", "← Previous", "Security &amp; Access"),
        "next": ("/docs/features/file-viewer.html", "Next →", "File Viewer"),
    },
    {
        "url": "/docs/features/file-viewer.html",
        "title": "File Viewer — Suwu Docs",
        "description": "View files with syntax highlighting, auto-refresh, and PDF rendering.",
        "lead": "View files with syntax highlighting, auto-refresh, and PDF rendering — perfect for monitoring logs and reviewing code without leaving the browser.",
        "breadcrumb": "File Viewer",
        "active": "file-viewer",
        "prev": ("/docs/features/file-browser.html", "← Previous", "File Browser"),
        "next": ("/docs/features/port-forwarding.html", "Next →", "Port Forwarding"),
    },
    {
        "url": "/docs/features/port-forwarding.html",
        "title": "Port Forwarding — Suwu Docs",
        "description": "TCP and UDP port forwarding from the browser.",
        "lead": "TCP and UDP port forwarding from the browser — access services on the remote machine without <code>ssh -L</code>.",
        "breadcrumb": "Port Forwarding",
        "active": "port-forwarding",
        "prev": ("/docs/features/file-viewer.html", "← Previous", "File Viewer"),
        "next": ("/docs/features/dropbox.html", "Next →", "Dropbox"),
    },
    {
        "url": "/docs/features/dropbox.html",
        "title": "Dropbox — Suwu Docs",
        "description": "Upload and download files between your local machine and the remote server.",
        "lead": "Upload and download files between your local machine and the remote server — drag and drop, or use the browser UI.",
        "breadcrumb": "Dropbox",
        "active": "dropbox",
        "prev": ("/docs/features/port-forwarding.html", "← Previous", "Port Forwarding"),
        "next": ("/docs/features/git-graph.html", "Next →", "Git Graph"),
    },
    {
        "url": "/docs/features/git-graph.html",
        "title": "Git Graph — Suwu Docs",
        "description": "Visualize branch history, commits, and merges in an interactive graph.",
        "lead": "Visualize branch history, commits, and merges in an interactive graph — see your repository's story at a glance.",
        "breadcrumb": "Git Graph",
        "active": "git-graph",
        "prev": ("/docs/features/dropbox.html", "← Previous", "Dropbox"),
        "next": ("/docs/features/diff-viewer.html", "Next →", "Diff Viewer"),
    },
    {
        "url": "/docs/features/diff-viewer.html",
        "title": "Diff Viewer — Suwu Docs",
        "description": "Side-by-side and inline diffs with syntax highlighting.",
        "lead": "Side-by-side and inline diffs with syntax highlighting — review changes without leaving the browser.",
        "breadcrumb": "Diff Viewer",
        "active": "diff-viewer",
        "prev": ("/docs/features/git-graph.html", "← Previous", "Git Graph"),
        "next": ("/docs/features/suwu-cli.html", "Next →", "Suwu CLI"),
    },
    {
        "url": "/docs/features/suwu-cli.html",
        "title": "Suwu CLI — Suwu Docs",
        "description": "suwu send, suwu forward, suwu open — bridge scripts and the web UI.",
        "lead": "<code>suwu send</code> posts notifications from any script. <code>suwu forward</code> opens a port-forwarding tile. <code>suwu open</code> resolves links and actions on the remote machine. Bridge your terminal and the web UI.",
        "breadcrumb": "Suwu CLI",
        "active": "suwu-cli",
        "prev": ("/docs/features/diff-viewer.html", "← Previous", "Diff Viewer"),
        "next": ("/docs/features/appearance.html", "Next →", "Appearance &amp; i18n"),
    },
    {
        "url": "/docs/features/appearance.html",
        "title": "Appearance &amp; i18n — Suwu Docs",
        "description": "Fonts, themes, glass alpha, and language settings.",
        "lead": "Pick your font family and size, theme the colors, dial in a glassy background alpha. The interface speaks English and Chinese out of the box.",
        "breadcrumb": "Appearance &amp; i18n",
        "active": "appearance",
        "prev": ("/docs/features/suwu-cli.html", "← Previous", "Suwu CLI"),
        "next": ("/docs/index.html", "Back to →", "Docs Index"),
    },
]

# ── Sidebar definition (shared across all pages) ─────────────────────────────

SIDEBAR_GROUPS = [
    ("Overview", [
        ("get-started", "Get Started", "/docs/get-started.html"),
        ("upgrading", "Upgrading", "/docs/upgrading.html"),
        ("security-data", "Security &amp; Data", "/docs/security-data.html"),
    ]),
    ("Core", [
        ("tiling-wm", "Tiling Window Manager", "/docs/features/tiling-wm.html"),
        ("terminals", "Terminals", "/docs/features/terminals.html"),
        ("security", "Security &amp; Access", "/docs/features/security.html"),
    ]),
    ("Apps", [
        ("file-browser", "File Browser", "/docs/features/file-browser.html"),
        ("file-viewer", "File Viewer", "/docs/features/file-viewer.html"),
        ("port-forwarding", "Port Forwarding", "/docs/features/port-forwarding.html"),
        ("dropbox", "Dropbox", "/docs/features/dropbox.html"),
    ]),
    ("Developer Tools", [
        ("git-graph", "Git Graph", "/docs/features/git-graph.html"),
        ("diff-viewer", "Diff Viewer", "/docs/features/diff-viewer.html"),
    ]),
    ("CLI &amp; Configuration", [
        ("suwu-cli", "Suwu CLI", "/docs/features/suwu-cli.html"),
        ("appearance", "Appearance &amp; i18n", "/docs/features/appearance.html"),
    ]),
]


def read_template(name):
    with open(os.path.join(TEMPLATEDIR, name), "r") as f:
        return f.read()


def read_content(name):
    path = os.path.join(CONTENTDIR, name)
    if not os.path.exists(path):
        return ""
    with open(path, "r") as f:
        return f.read()


def slugify(text):
    """Create an anchor slug from heading text."""
    import re
    clean = re.sub(r'<[^>]+>', '', text).strip()
    return re.sub(r'[^a-z0-9]+', '-', clean.lower()).strip('-')


def add_heading_ids(content_html):
    """Add id attributes to h2/h3 elements for TOC anchoring."""
    import re
    def replace_heading(m):
        tag = m.group(1)
        attrs = m.group(2) or ''
        inner = m.group(3)
        if 'id=' not in attrs:
            slug = slugify(inner)
            return f'<h{tag} id="{slug}"{attrs}>{inner}</h{tag}>'
        return m.group(0)
    return re.sub(r'<h([23])(\s[^>]*)?>(.*?)</h\1>', replace_heading, content_html)


def build_toc(content_html):
    """Extract h2/h3 headings from content and build a TOC sidebar."""
    import re
    headings = re.findall(r'<h([23])\b[^>]*>(.*?)</h\1>', content_html)
    if not headings:
        return ""

    lines = [
        '    <aside class="doc-toc">',
        '      <nav aria-label="Table of contents">',
        '        <p class="doc-toc-title">On this page</p>',
        '        <ul class="doc-toc-list">',
    ]

    for level, text in headings:
        clean = re.sub(r'<[^>]+>', '', text).strip()
        slug = slugify(text)
        indent = '          ' if level == '3' else ''
        cls = ' class="doc-toc-sub"' if level == '3' else ''
        lines.append(f'{indent}<li{cls}><a href="#{slug}">{clean}</a></li>')

    lines.append('        </ul>')
    lines.append('      </nav>')
    lines.append('    </aside>')
    return "\n".join(lines)


def build_sidebar(active):
    """Build sidebar HTML. All links are absolute paths."""
    lines = [
        '    <aside class="doc-sidebar">',
        '      <p class="doc-sidebar-title">Docs</p>',
        '      <nav aria-label="Docs sidebar">',
    ]

    for group_name, items in SIDEBAR_GROUPS:
        lines.append('        <div class="doc-sidebar-group">')
        lines.append(f'          <p class="doc-sidebar-title">{group_name}</p>')
        lines.append('          <ul class="doc-sidebar-nav">')
        for slug, title, url in items:
            current = ' aria-current="page"' if slug == active else ""
            lines.append(f'            <li><a href="{url}"{current}>{title}</a></li>')
        lines.append("          </ul>")
        lines.append("        </div>")

    lines.append("      </nav>")
    lines.append("    </aside>")
    return "\n".join(lines)


# ── Shared HTML fragments ────────────────────────────────────────────────────

HEAD_OPEN = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />"""

CSS_LINKS = """  <link rel="icon" type="image/svg+xml" href="/logo.svg" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Open+Sans:wght@400;500;600&family=Inconsolata:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/styles.css" />
  <link rel="stylesheet" href="/docs/styles.css" />"""

HEADER = """  <header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="/#top" aria-label="Suwu home">
        <span class="brand-name">Suwu</span>
      </a>
      <nav class="site-nav" aria-label="Main">
        <a href="/#features">Features</a>
        <a href="/docs/index.html">Docs</a>
        <a href="/#install">Install</a>
        <a class="nav-github" href="https://github.com/liyu1981/suwu" rel="noopener">GitHub</a>
      </nav>
    </div>
  </header>"""

FOOTER = read_template("_footer.html")

LIGHTBOX = '''  <!-- Lightbox -->
  <div class="lightbox" id="lightbox" role="dialog" aria-modal="true" aria-label="Video lightbox">
    <button class="lightbox-close" type="button" aria-label="Close">
      <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>
    <div class="lightbox-video-wrap">
      <video id="lightbox-video" controls playsinline></video>
    </div>
  </div>

  <script src="/js/shared.js"></script>'''

LIGHTBOX_INDEX = '''  <!-- Lightbox -->
  <div class="lightbox" id="lightbox" role="dialog" aria-modal="true" aria-label="Video lightbox">
    <button class="lightbox-close" type="button" aria-label="Close">
      <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>
    <div class="lightbox-video-wrap">
      <video id="lightbox-video" controls playsinline></video>
    </div>
  </div>

  <script src="/js/shared.js"></script>'''


def build_page(page):
    """Build a single doc page."""
    sidebar = build_sidebar(page["active"])

    # Head
    head = f"""{HEAD_OPEN}
  <title>{page["title"]}</title>
  <meta name="description" content="{page["description"]}" />
{CSS_LINKS}
</head>"""

    # Breadcrumb
    breadcrumb = f"""      <nav aria-label="Breadcrumb">
        <ol class="breadcrumb">
          <li><a href="/#top">Suwu</a></li>
          <li><a href="/docs/index.html">Docs</a></li>
          <li><span aria-current="page">{page["breadcrumb"]}</span></li>
        </ol>
      </nav>"""

    # Header section
    header_section = f"""      <div class="doc-header">
        <h1>{page["breadcrumb"]}</h1>
        <p class="doc-lead">{page["lead"]}</p>
      </div>"""

    # Content
    content_file = page["url"].split("/")[-1].replace(".html", ".content.html")
    content_body = read_content(content_file)
    content_body = add_heading_ids(content_body)

    # Table of contents (from h2/h3 in content)
    toc = build_toc(content_body)

    # Nav
    prev_href, prev_label, prev_title = page["prev"]
    next_href, next_label, next_title = page["next"]
    nav_html = f"""      <nav class="doc-nav" aria-label="Prev / Next">
        <a href="{prev_href}">
          <span class="doc-nav-label">{prev_label}</span>
          <span class="doc-nav-title">{prev_title}</span>
        </a>
        <a href="{next_href}" class="doc-nav-next">
          <span class="doc-nav-label">{next_label}</span>
          <span class="doc-nav-title">{next_title}</span>
        </a>
      </nav>"""

    # Content wrapper with prose class
    content_block = f'<div class="prose">\n{content_body}\n</div>'

    return f"""{head}
<body>
  <a class="skip-link" href="#main">Skip to content</a>

{HEADER}

  <main id="main" class="doc-page">
<div class="doc-layout">
{sidebar}
    <div class="doc-main">
{breadcrumb}
{header_section}
{content_block}
{nav_html}
    </div><!-- .doc-main -->
{toc}
    </div><!-- .doc-layout -->
  </main>

{FOOTER}
{LIGHTBOX}
</body>
</html>
"""


def build_index():
    """Build the docs index page."""
    sidebar = build_sidebar("")
    content = read_content("index.content.html")

    head = f"""{HEAD_OPEN}
  <title>Docs — Suwu</title>
  <meta name="description" content="Feature documentation for Suwu — the web-based remote shell with a tiling workspace." />
{CSS_LINKS}
</head>"""

    breadcrumb = """      <nav aria-label="Breadcrumb">
        <ol class="breadcrumb">
          <li><a href="/#top">Suwu</a></li>
          <li><span aria-current="page">Docs</span></li>
        </ol>
      </nav>"""

    header_section = """      <div class="doc-header">
        <h1>Feature Docs</h1>
        <p class="doc-lead">Everything you need to get the most out of Suwu — from keyboard shortcuts to CLI commands.</p>
      </div>"""

    return f"""{head}
<body>
  <a class="skip-link" href="#main">Skip to content</a>

{HEADER}

  <main id="main" class="doc-page">
<div class="doc-layout">
{sidebar}
    <div class="doc-main">
    <div class="container">
{breadcrumb}
{header_section}
{content}
    </div><!-- .container -->
    </div><!-- .doc-main -->
    </div><!-- .doc-layout -->
  </main>

{FOOTER}
{LIGHTBOX_INDEX}
</body>
</html>
"""


def main():
    for page in PAGES:
        # /docs/features/tiling-wm.html -> features/tiling-wm.html
        rel = page["url"].removeprefix("/docs/")
        out_path = os.path.join(DOCDIR, rel)
        html = build_page(page)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "w") as f:
            f.write(html)
        print(f"Built: {rel}")

    # Index page
    out_path = os.path.join(DOCDIR, "index.html")
    html = build_index()
    with open(out_path, "w") as f:
        f.write(html)
    print("Built: index.html")


if __name__ == "__main__":
    main()
