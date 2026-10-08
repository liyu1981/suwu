// Shared math for the Hexagon Landscape port.
//
// Everything here is used by both sides of the original's two-pass design: the
// one-off buffer pass (field.wgsl bakes the offset-hexagon distance field,
// height.wgsl the height map) and the raymarch pass (scene.wgsl). The vertex
// offsets must come from exactly this code — the scene pass reconstructs a
// block's vertices to paint its windows, and any drift would tear the windows
// off the cached field.
//
// Ported from the "Common" tab of "Asymmetric Hexagon Landscape" by Shane,
// https://www.shadertoy.com/view/tdtyDs (Shadertoy). The unused pieces of the
// original (pentagon edge IDs, the line-box helper, the cube-map face reader)
// are not carried over.

// -- Constants (the original's #defines) ------------------------------------

// Grid repeat scale: repSc = 1024/32 in the original.
export const REP_SC: f32 = 32.0;
// Extruded block scale — the original's `GSCALE vec2(1./8.)`.
export const GSCALE: f32 = 0.125;
// Quantization levels for building heights (and the water level, 7.22/19).
export const LEVELS: f32 = 19.0;
export const WLEV: f32 = 7.22;
// Side-height scaling applied after quantization (the original's `hs`).
export const HS: f32 = 0.6;
// Vertex jitter of the offset hexagons (`vo`), and the nudge that rounds them.
export const VO: f32 = 0.15;
export const NDG: f32 = 0.0175; // .0175 * 8. * GSCALE
// The baked field / height map are one tile of world space, wrapped by the
// scene pass with fract().
export const FIELD_SIZE: f32 = 1024.0;
export const FIELD_TEXELS: i32 = 1024;
// World space the height map covers before it repeats (p / 16. in hmBlock).
export const HEIGHT_WRAP: f32 = 16.0;

// -- Helpers ----------------------------------------------------------------

// GLSL's mod(): the floor-based, always-positive remainder. Block IDs go
// negative whenever the camera path wanders left of the origin, and WGSL's `%`
// does not wrap like this, so every `mod()` of the original routes through
// wrap1/wrap2/wrap4.
export fn wrap1(x: f32, y: f32) -> f32 {
  return x - y * floor(x / y);
}

export fn wrap2(v: vec2f, y: f32) -> vec2f {
  return v - y * floor(v / y);
}

export fn wrap4(v: vec4f, y: f32) -> vec4f {
  return v - y * floor(v / y);
}

// Standard 2D rotation formula.
export fn rot2(a: f32) -> mat2x2f {
  let c = cos(a);
  let s = sin(a);
  return mat2x2f(vec2f(c, -s), vec2f(s, c));
}

// IQ's vec2 to float hash.
export fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(27.609, 57.583))) * 43758.5453);
}

// Based on IQ's hash formula. Quantizes a block-corner position onto the
// 1024th grid, wraps it to the tiling period (four cells — one world unit),
// then scrambles it. Identical input, identical offset — both passes depend on
// that.
export fn hash42B(p_in: vec4f) -> vec4f {
  var p = (floor(p_in * 1024.0) + 0.5) / 1024.0;
  p = wrap4(p * REP_SC * GSCALE * 2.0, REP_SC);
  p = vec4f(
    dot(p.xy, vec2f(27.619, 113.583)),
    dot(p.xy, vec2f(57.527, 85.491)),
    dot(p.zw, vec2f(27.619, 113.583)),
    dot(p.zw, vec2f(57.527, 85.491)),
  );
  return fract(sin(p) * 43758.5453) * 2.0 - 1.0;
}

// vec2 to vec2 hash — the original's "faster, when framerate is an issue" one.
export fn hash22C(p_in: vec2f) -> vec2f {
  let p = wrap2(p_in, REP_SC);
  let n = sin(vec2f(dot(p, vec2f(27.29, 57.81)), dot(p, vec2f(7.14, 113.43))));
  return fract(vec2f(262144.1397, 32768.8793) * n) * 2.0 - 1.0;
}

// Based on IQ's gradient noise formula (quintic interpolation).
export fn n2D3G(p_in: vec2f) -> f32 {
  var p = p_in;
  let i = floor(p);
  p -= i;

  var v: vec4f;
  v.x = dot(hash22C(i), p);
  v.y = dot(hash22C(i + vec2f(1.0, 0.0)), p - vec2f(1.0, 0.0));
  v.z = dot(hash22C(i + vec2f(0.0, 1.0)), p - vec2f(0.0, 1.0));
  v.w = dot(hash22C(i + vec2f(1.0, 1.0)), p - vec2f(1.0, 1.0));

  // Quintic interpolation.
  p = p * p * p * (p * (p * 6.0 - 15.0) + 10.0);

  return mix(mix(v.x, v.y, p.x), mix(v.z, v.w, p.x), p.y);
}

// Height map: one layer of gradient noise. Because hash22C wraps at REP_SC,
// this tiles with period 1 — which is what lets the baked height texture wrap.
export fn hm(p: vec2f) -> f32 {
  return n2D3G(p * REP_SC) * 0.5 + 0.5;
}

// The camera path: a 2D sinusoid over the travel axis.
export fn path(z: f32) -> vec2f {
  return vec2f(3.0 * sin(z * 0.1) + 0.5 * cos(z * 0.4), 0.25 * (sin(z * 0.875) * 0.5 + 0.5));
}

// IQ's extrusion formula: lift a 2D distance field into a slab of height h.
export fn op_extrusion(sdf: f32, pz: f32, h: f32) -> f32 {
  let w = vec2f(sdf, abs(pz) - h);
  return min(max(w.x, w.y), 0.0) + length(max(w, vec2f(0.0)));
}

// IQ's distance to a hexagon (a "polygon without trigonometric functions").
export fn sd_poly(p: vec2f, v: array<vec2f, 6>) -> f32 {
  var d = dot(p - v[0], p - v[0]);
  var s = 1.0;
  var j = 5;
  for (var i = 0; i < 6; i++) {
    // Distance.
    let e = v[j] - v[i];
    let w = p - v[i];
    let b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    d = min(d, dot(b, b));

    // Winding number from http://geomalgorithms.com/a03-_inclusion.html
    // (the original's bvec3 + all()/all(not()): true thrice or false thrice).
    let c1 = p.y >= v[i].y;
    let c2 = p.y < v[j].y;
    let c3 = e.x * w.y > e.y * w.x;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) {
      s *= -1.0;
    }
    j = i;
  }
  return s * sqrt(d);
}

// IQ's standard box function.
export fn s_box(p: vec2f, b: vec2f) -> f32 {
  let d = abs(p) - b;
  return min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0)));
}

// Flat-top hexagon vertices, clockwise from the left point: two vertices per
// vec4 (xy then zw), three vec4s — the original's `vID`.
export fn vertex_id() -> array<vec4f, 3> {
  return array<vec4f, 3>(
    vec4f(-2.0 / 3.0, 0.0, -2.0 / 6.0, 0.5),
    vec4f(2.0 / 6.0, 0.5, 2.0 / 3.0, 0.0),
    vec4f(2.0 / 6.0, -0.5, -2.0 / 6.0, -0.5),
  );
}

// The offset, scaled hexagon vertices of the block with (unscaled) ID idi.
// `OFFSET_VERTICES` is always on in this port: the offsets are what gives the
// grid its randomly-packed-polygon look.
export fn offset_verts(idi: vec2f) -> array<vec4f, 3> {
  var v = vertex_id();
  let dim = vec2f(GSCALE, GSCALE);
  for (var k = 0; k < 3; k++) {
    // Accuracy matters here: the ID must be the same unscaled value both the
    // buffer pass and the scene pass hash, or the vertices stop meeting.
    let q = idi.xyxy + v[k] * 0.5;
    v[k] = v[k] + hash42B(q) * VO;
    v[k] = v[k] * vec4f(dim, dim);
  }
  return v;
}
