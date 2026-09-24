/**
 * eye — a classic X11 "eye" that follows the pointer.
 *
 * Runs once in gqjs to produce a self-contained HTML page; all mouse tracking
 * happens client-side inside the sandboxed extension iframe.
 */
function handler(input) {
  const params = input && input.params ? input.params : {};
  const size = clampInt(params.size, 140, 40, 400);

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #101014; }
  canvas { display: block; width: 100%; height: 100%; }
</style>
</head>
<body>
<canvas id="eye"></canvas>
<script>
(function () {
  var SIZE = ${size};
  var canvas = document.getElementById('eye');
  var ctx = canvas.getContext('2d');
  var mx = innerWidth / 2, my = innerHeight / 2;
  var px = mx, py = my;

  addEventListener('mousemove', function (e) { mx = e.clientX; my = e.clientY; });
  addEventListener('mouseleave', function () { mx = innerWidth / 2; my = innerHeight / 2; });

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function draw() {
    var w = canvas.width = innerWidth;
    var h = canvas.height = innerHeight;
    var cx = w / 2, cy = h / 2;

    // Smoothly chase the pointer.
    px += (mx - px) * 0.18;
    py += (my - py) * 0.18;

    var dx = px - cx, dy = py - cy;
    var dist = Math.sqrt(dx * dx + dy * dy) || 1;
    // Pupil offset keeps it inside the sclera.
    var reach = SIZE * 0.34;
    var k = Math.min(1, reach / Math.max(dist, reach * 0.35));
    var ox = cx + dx * k;
    var oy = cy + dy * k;

    // Sclera.
    ctx.clearRect(0, 0, w, h);
    var grad = ctx.createRadialGradient(cx, cy - SIZE * 0.2, SIZE * 0.1, cx, cy, SIZE);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, '#e2e8f0');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, SIZE, 0, Math.PI * 2);
    ctx.fill();

    // Iris.
    var iris = ctx.createRadialGradient(ox, oy, SIZE * 0.05, ox, oy, SIZE * 0.5);
    iris.addColorStop(0, '#22d3ee');
    iris.addColorStop(1, '#0e7490');
    ctx.fillStyle = iris;
    ctx.beginPath();
    ctx.arc(ox, oy, SIZE * 0.46, 0, Math.PI * 2);
    ctx.fill();

    // Pupil.
    ctx.fillStyle = '#020617';
    ctx.beginPath();
    ctx.arc(ox, oy, SIZE * 0.2, 0, Math.PI * 2);
    ctx.fill();

    // Highlight.
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(ox - SIZE * 0.14, oy - SIZE * 0.14, SIZE * 0.07, 0, Math.PI * 2);
    ctx.fill();

    requestAnimationFrame(draw);
  }
  draw();
})();
<\/script>
</body>
</html>`;

  return { body: html };
}

function clampInt(v, fallback, lo, hi) {
  var n = parseInt(v, 10);
  if (isNaN(n)) return fallback;
  return n < lo ? lo : n > hi ? hi : n;
}
