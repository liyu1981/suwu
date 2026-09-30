/**
 * eye — a classic X11 "eye" that follows the pointer.
 *
 * Render returns a small stub; the CSS and the classic script come from the
 * extension's static directory (package.json → suwu.static). The size param
 * is server-rendered into a data attribute: secrets belong in the
 * authenticated HTML only — static files are served unauthenticated
 * (docs/EXTENSION_API_PLAN.md §2.8).
 */
function handler(input) {
  const params = input && input.params ? input.params : {};
  const size = clampInt(params.size, 140, 40, 400);
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Eye</title>
<link rel="stylesheet" href="/gqjs/static/eye/style.css">
</head>
<body>
<canvas id="eye" data-size="${size}"></canvas>
<script src="/gqjs/static/eye/eye.js"></script>
</body>
</html>
`
  };
}

function clampInt(v, fallback, lo, hi) {
  var n = parseInt(v, 10);
  if (isNaN(n)) return fallback;
  return n < lo ? lo : n > hi ? hi : n;
}
