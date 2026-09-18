// Cosmos in Crystal — a kaleidoscopic space tunnel: a volumetric starfield
// (main_vr) tinted by an animated "oil noise" field, with drifting glowing
// holes and a central bloom.
//
// Original work: "Cosmos in Crystal" by nayk —
//   https://www.shadertoy.com/view/MXccR4
//
// Adaptation notes:
//   * GLSL→WGSL: helpers are renamed, `out` params become return values, and
//     fragment Y is flipped (WebGPU's origin is top-left, GLSL's bottom-left).
//   * Dropped code that cannot affect the result: the unused `happy_star` /
//     `cos1d` helpers, the 1×1 anti-aliasing loop (AA = 1), the unused
//     `stMask` / `uv2` / `resolution` / `color` / `baseColor` / `amplitude`
//     locals, and the glow block — the original overwrites `col2` immediately,
//     so only `1 - exp(-col)` survives.
//   * Locals the original leaves uninitialized (`col`, `final`) are zeroed,
//     which is what GLSL drivers effectively do.

struct Params {
  resolution: vec2f,
  time: f32,
  _pad: f32,
}

@group(0) @binding(0) var<uniform> params: Params;

const PI: f32 = 3.141592;
const TWOPI: f32 = 6.283184;
const ITERATIONS: i32 = 13;
const FORMUPARAM: f32 = 0.53;
const VOLSTEPS: i32 = 20;
const STEPSIZE: f32 = 0.1;
const ZOOM: f32 = 0.800;
const TILE: f32 = 0.850;
const BRIGHTNESS: f32 = 0.0015;
const DARKMATTER: f32 = 0.300;
const DISTFADING: f32 = 0.730;
const SATURATION: f32 = 0.850;
const OIL_OCTAVES: f32 = 15.0;

fn rot_mat(r: f32) -> mat2x2f {
  let c = cos(r);
  let s = sin(r);
  return mat2x2f(c, -s, s, c);
}

// fract -> -0.5 -> abs: coordinate absolute looping.
fn abs1d(x: f32) -> f32 {
  return abs(fract(x) - 0.5);
}
fn abs2d(v: vec2f) -> vec2f {
  return abs(fract(v) - 0.5);
}
fn sin1d(p: f32) -> f32 {
  return sin(p * TWOPI) * 0.25 + 0.25;
}

fn oil_noise(pos_in: vec2f, rgb: vec3f) -> vec3f {
  var pos = pos_in;
  var q = vec2f(0.0);
  var result = 0.0;
  var s = 2.2;
  let gain = 0.44;
  var a_pos = abs2d(pos) * 0.5;

  for (var i = 0.0; i < OIL_OCTAVES; i = i + 1.0) {
    pos = pos * rot_mat(PI / 180.0 * 30.0);
    let t = (sin(params.time) * 0.5 + 0.5) * 0.2 + params.time * 0.8;
    q = pos * s + t;
    q = pos * s + a_pos + t;
    q = cos(q);

    result += sin1d(dot(q, vec2f(0.3))) * gain;

    s *= 1.07;
    a_pos += cos(smoothstep(vec2f(0.0), vec2f(0.15), q));
    a_pos = a_pos * rot_mat(PI / 180.0 * 5.0);
    a_pos *= 1.232;
  }

  result = pow(result, 4.504);
  return clamp(rgb / abs1d(dot(q, vec2f(-0.240, 0.0))) * 0.5 / result, vec3f(0.0), vec3f(1.0));
}

fn ease_fade(x: f32) -> f32 {
  return 1.0 - (2.0 * x - 1.0) * (2.0 * x - 1.0) * (2.0 * x - 1.0) * (2.0 * x - 1.0);
}

// GLSL `mod` uses floor (WGSL `%` on floats does not).
fn glsl_mod(x: f32, y: f32) -> f32 {
  return x - y * floor(x / y);
}

fn hole_fade(t: f32, life: f32, lo: f32) -> f32 {
  return ease_fade(glsl_mod(t - lo, life) / life);
}

fn get_pos(t: f32, life: f32, offset: f32, lo: f32) -> vec2f {
  let k = floor((t - lo) / life) * life;
  return vec2f(
    cos(offset + k) * params.resolution.x / 2.0,
    sin(2.0 * offset + k) * params.resolution.y / 2.0,
  );
}

fn main_vr(ro: vec3f, rd: vec3f) -> vec4f {
  let dir = rd;
  let origin = ro;
  var s = 0.1;
  var fade = 1.0;
  var v = vec3f(0.0);

  for (var r = 0; r < VOLSTEPS; r++) {
    var p = origin + s * dir * 0.5;
    // Tiling fold.
    p = abs(vec3f(TILE) - (p - vec3f(TILE * 2.0) * floor(p / vec3f(TILE * 2.0))));

    var pa = 0.0;
    var a = 0.0;
    for (var i = 0; i < ITERATIONS; i++) {
      p = abs(p) / dot(p, p) - FORMUPARAM;
      let rot = mat2x2f(
        cos(params.time * 0.01), sin(params.time * 0.01),
        -sin(params.time * 0.01), cos(params.time * 0.01),
      );
      p = vec3f(vec2f(p.xy * rot), p.z);
      a += abs(length(p) - pa);
      pa = length(p);
    }

    let dm = max(0.0, DARKMATTER - a * a * 0.001);
    a *= a * a;
    if (r > 6) {
      fade *= 1.3 - dm;
    }
    v += fade;
    v += vec3f(s, s * s, s * s * s * s) * a * BRIGHTNESS * fade;
    fade *= DISTFADING;
    s += STEPSIZE;
  }

  v = mix(vec3f(length(v)), v, SATURATION);
  return vec4f(v * 0.01, 1.0);
}

// GLSL `Q(p)`: p *= 2. * mat2(cos(a + asin(vec4(0,1,-1,0)))), a = round(atan2(p.x, p.y)*4)/4.
fn q_rotate(p: vec2f) -> vec2f {
  let a = round(atan2(p.x, p.y) * 4.0) / 4.0;
  let m = 2.0 * mat2x2f(cos(a), -sin(a), sin(a), cos(a));
  return p * m;
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let resolution = params.resolution;
  let time = params.time;
  // GLSL fragment coordinates are bottom-up; WebGPU's are top-down.
  let frag_coord = vec2f(position.x, resolution.y - position.y);

  var uv = frag_coord / resolution - 0.5;
  let c_pos = -1.0 + 2.0 * frag_coord / resolution;
  let c_length = length(c_pos);

  var st = frag_coord / resolution;
  st = vec2f(((st.x - 0.5) * (resolution.x / resolution.y)) + 0.5, st.y);
  st *= 3.0;

  // Oil-noise colour field (the original's AA loop collapses to one sample).
  let rgb = vec3f(0.30, 0.8, 1.200);
  let pix = 1.0 / resolution;
  let col = oil_noise(st + pix * 0.5, rgb);

  uv = vec2f(uv.x, uv.y * (resolution.y / resolution.x));

  // Plasma loop.
  var u = 0.2 * (frag_coord + frag_coord - resolution) / resolution.y;
  var v = resolution;
  var w = vec2f(0.0);
  var k = u;
  var o = vec4f(1.0, 2.0, 3.0, 0.0);
  var a = 0.5;
  var t = time * 0.21;
  var i = 0.0;
  loop {
    i += 1.0;
    if (!(i < 19.0)) {
      break;
    }
    t += 1.0;
    a += 0.03;
    v = cos(t - 7.0 * u * pow(a, i)) - 5.0 * u;

    let arg = vec4f(i + t * 0.02) - vec4f(0.0, 11.0, 33.0, 0.0);
    let cc = cos(arg);
    u = u * mat2x2f(cc.x, cc.y, cc.z, cc.w);

    u += 0.005 * tanh(40.0 * dot(u, u) * cos(100.0 * u.yx + t))
      + 0.2 * a * u
      + 0.003 * cos(t + 4.0 * exp(-0.01 * dot(o, o)));
    w = u / (1.0 - 2.0 * dot(u, u));

    o += (vec4f(1.0) + cos(vec4f(0.0, 1.0, 3.0, 0.0) + t))
      / length((1.0 + i * dot(v, v)) * sin(w * 3.0 - 9.0 * u.yx + t));
  }

  let inner = vec4f(1.0) - sqrt(exp(-o * o * o / 200.0));
  let expo = 0.3 * inner / inner;
  let kk = k - u;
  o = pow(inner, expo) - dot(kk, kk) / 250.0;

  let dir = vec3f(uv * ZOOM, 1.0);
  var origin = vec3f(1.0, 0.5, 0.5);
  origin = vec3f(q_rotate(origin.xy), origin.z);
  origin = vec3f(origin.xy + (c_pos / c_length) * cos(c_length * 8.0 - time * 2.0) * 0.03, origin.z);

  // Drifting glowing holes.
  var holes = vec3f(0.0);
  let coord = frag_coord * 2.0 - resolution;
  let hole_size = resolution.y / 10.0;
  let hole_life = 2.0;
  for (var h = 0; h < 45; h++) {
    let fi = f32(h);
    let hcol = vec3f(0.5) + 0.5 * cos(time + uv.xyx + vec3f(fi, 2.0 * fi + 4.0, 4.0 * fi + 16.0));
    let life_offset = fi / 2.0;
    let hole_pos = get_pos(time, hole_life, fi * 4.5, life_offset);
    var d = distance(coord, hole_pos) / hole_size;
    d = 1.0 / d - 0.1;
    holes += mix(vec3f(0.0), hcol, d) * hole_fade(time, hole_life, life_offset);
  }

  // The original's glow reduces to `1 - exp(-col)` (its first `col2` is
  // immediately overwritten).
  let col2 = vec3f(1.0) - exp(-col);

  var frag = main_vr(origin, dir);
  frag = frag * vec4f(holes * vec3f(0.4, 1.0, 1.0) + o.xyz, 1.0);
  frag = frag + vec4f(col2, 1.0);
  return frag;
}
