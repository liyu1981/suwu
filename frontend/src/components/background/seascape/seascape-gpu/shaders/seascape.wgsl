// Seascape — a procedural, raymarched ocean.
//
// Ported to WGSL/vgpu from "Seascape" by Alexander Alekseev aka TDM (2014),
// https://www.shadertoy.com/view/Ms2SD1
// License: Creative Commons Attribution-NonCommercial-ShareAlike 3.0 Unported.
//
// Adaptation notes:
//   * The `iMouse` term is dropped; the camera is purely time-driven, with the
//     host scaling `time` by the user's animation-speed setting.
//   * Fragment Y is flipped: WebGPU's origin is top-left, GLSL's is bottom-left.
//   * The march runs into an offscreen target capped by the host and is blitted
//     to the canvas, so the sea never over-spends pixels on a high-DPR display.

struct Params {
  resolution: vec2f,
  time: f32,
  _pad: f32,
}

@group(0) @binding(0) var<uniform> params: Params;

const NUM_STEPS: i32 = 32;
const PI: f32 = 3.141592;
const EPSILON: f32 = 1e-3;

// Sea
const ITER_GEOMETRY: i32 = 3;
const ITER_FRAGMENT: i32 = 5;
const SEA_HEIGHT: f32 = 0.6;
const SEA_CHOPPY: f32 = 4.0;
const SEA_SPEED: f32 = 0.8;
const SEA_FREQ: f32 = 0.16;
const SEA_BASE = vec3f(0.0, 0.09, 0.18);
const SEA_WATER_COLOR = vec3f(0.8, 0.9, 0.6) * 0.6;
const OCTAVE_M = mat2x2f(vec2f(1.6, 1.2), vec2f(-1.2, 1.6));

fn from_euler(ang: vec3f) -> mat3x3f {
  let a1 = vec2f(sin(ang.x), cos(ang.x));
  let a2 = vec2f(sin(ang.y), cos(ang.y));
  let a3 = vec2f(sin(ang.z), cos(ang.z));
  return mat3x3f(
    vec3f(
      a1.y * a3.y + a1.x * a2.x * a3.x,
      a1.y * a2.x * a3.x + a3.y * a1.x,
      -a2.y * a3.x,
    ),
    vec3f(-a2.y * a1.x, a1.y * a2.y, a2.x),
    vec3f(
      a3.y * a1.x * a2.x + a1.y * a3.x,
      a1.x * a3.x - a1.y * a3.y * a2.x,
      a2.y * a3.y,
    ),
  );
}

fn hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453123);
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return -1.0 + 2.0 * mix(
    mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), u.x),
    mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), u.x),
    u.y,
  );
}

// Lighting
fn diffuse(n: vec3f, l: vec3f, p: f32) -> f32 {
  return pow(dot(n, l) * 0.4 + 0.6, p);
}

fn specular(n: vec3f, l: vec3f, e: vec3f, s: f32) -> f32 {
  let nrm = (s + 8.0) / (PI * 8.0);
  return pow(max(dot(reflect(e, n), l), 0.0), s) * nrm;
}

// Sky
// Suwu darkens the original sky for a calmer, lower-contrast backdrop.
const SKY_BRIGHTNESS: f32 = 0.5;

fn get_sky_color(e: vec3f) -> vec3f {
  let ey = (max(e.y, 0.0) * 0.8 + 0.2) * 0.8;
  return vec3f(pow(1.0 - ey, 2.0), 1.0 - ey, 0.6 + (1.0 - ey) * 0.4) * 1.1 * SKY_BRIGHTNESS;
}

// Sea surface
fn sea_octave(uv_in: vec2f, choppy: f32) -> f32 {
  let uv = uv_in + noise(uv_in);
  let wv = 1.0 - abs(sin(uv));
  let swv = abs(cos(uv));
  let mixed = mix(wv, swv, wv);
  return pow(1.0 - pow(mixed.x * mixed.y, 0.65), choppy);
}

fn map(p: vec3f, sea_time: f32) -> f32 {
  var freq = SEA_FREQ;
  var amp = SEA_HEIGHT;
  var choppy = SEA_CHOPPY;
  var uv = p.xz;
  uv.x = uv.x * 0.75;

  var h = 0.0;
  for (var i = 0; i < ITER_GEOMETRY; i = i + 1) {
    var d = sea_octave((uv + sea_time) * freq, choppy);
    d = d + sea_octave((uv - sea_time) * freq, choppy);
    h = h + d * amp;
    uv = uv * OCTAVE_M;
    freq = freq * 1.9;
    amp = amp * 0.22;
    choppy = mix(choppy, 1.0, 0.2);
  }
  return p.y - h;
}

fn map_detailed(p: vec3f, sea_time: f32) -> f32 {
  var freq = SEA_FREQ;
  var amp = SEA_HEIGHT;
  var choppy = SEA_CHOPPY;
  var uv = p.xz;
  uv.x = uv.x * 0.75;

  var h = 0.0;
  for (var i = 0; i < ITER_FRAGMENT; i = i + 1) {
    var d = sea_octave((uv + sea_time) * freq, choppy);
    d = d + sea_octave((uv - sea_time) * freq, choppy);
    h = h + d * amp;
    uv = uv * OCTAVE_M;
    freq = freq * 1.9;
    amp = amp * 0.22;
    choppy = mix(choppy, 1.0, 0.2);
  }
  return p.y - h;
}

fn get_sea_color(p: vec3f, n: vec3f, l: vec3f, eye: vec3f, dist: vec3f) -> vec3f {
  var fresnel = clamp(1.0 - dot(n, -eye), 0.0, 1.0);
  fresnel = min(fresnel * fresnel * fresnel, 0.5);

  let reflected = get_sky_color(reflect(eye, n));
  let refracted = SEA_BASE + diffuse(n, l, 80.0) * SEA_WATER_COLOR * 0.12;
  var color = mix(refracted, reflected, fresnel);

  let atten = max(1.0 - dot(dist, dist) * 0.001, 0.0);
  color = color + SEA_WATER_COLOR * (p.y - SEA_HEIGHT) * 0.18 * atten;
  color = color + specular(n, l, eye, 600.0 * inverseSqrt(dot(dist, dist)));

  return color;
}

// Tracing
fn get_normal(p: vec3f, eps: f32, sea_time: f32) -> vec3f {
  let base = map_detailed(p, sea_time);
  return normalize(vec3f(
    map_detailed(vec3f(p.x + eps, p.y, p.z), sea_time) - base,
    eps,
    map_detailed(vec3f(p.x, p.y, p.z + eps), sea_time) - base,
  ));
}

// Bisection march against the height field; returns the last surface point.
fn height_map_tracing(ori: vec3f, dir: vec3f, sea_time: f32) -> vec3f {
  var tm = 0.0;
  var tx = 1000.0;
  var hx = map(ori + dir * tx, sea_time);
  var p = ori + dir * tx;
  if (hx > 0.0) {
    return p;
  }

  var hm = map(ori, sea_time);
  for (var i = 0; i < NUM_STEPS; i = i + 1) {
    let tmid = mix(tm, tx, hm / (hm - hx));
    p = ori + dir * tmid;
    let hmid = map(p, sea_time);
    if (hmid < 0.0) {
      tx = tmid;
      hx = hmid;
    } else {
      tm = tmid;
      hm = hmid;
    }
    if (abs(hmid) < EPSILON) {
      break;
    }
  }
  return p;
}

fn get_pixel(coord: vec2f, time: f32, sea_time: f32, resolution: vec2f, epsilon_nrm: f32) -> vec3f {
  var uv = coord / resolution;
  uv = uv * 2.0 - 1.0;
  uv.x = uv.x * resolution.x / resolution.y;

  // Ray
  let ang = vec3f(sin(time * 3.0) * 0.1, sin(time) * 0.2 + 0.3, time);
  let ori = vec3f(0.0, 3.5, time * 5.0);
  var dir = normalize(vec3f(uv, -2.0));
  dir.z = dir.z + length(uv) * 0.14;
  dir = normalize(dir) * from_euler(ang);

  // Tracing
  let p = height_map_tracing(ori, dir, sea_time);
  let dist = p - ori;
  let n = get_normal(p, dot(dist, dist) * epsilon_nrm, sea_time);
  let light = normalize(vec3f(0.0, 1.0, 0.8));

  // Color
  return mix(
    get_sky_color(dir),
    get_sea_color(p, n, light, dir, dist),
    pow(1.0 - smoothstep(-0.02, 0.0, dir.y), 0.2),
  );
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let resolution = params.resolution;
  // GLSL fragment coordinates are bottom-up; WebGPU's are top-down.
  let coord = vec2f(position.x, resolution.y - position.y);

  let raw_time = params.time;
  let time = raw_time * 0.3;
  let sea_time = 1.0 + raw_time * SEA_SPEED;
  let epsilon_nrm = 0.1 / resolution.x;

  let color = get_pixel(coord, time, sea_time, resolution, epsilon_nrm);
  return vec4f(pow(color, vec3f(0.65)), 1.0);
}
