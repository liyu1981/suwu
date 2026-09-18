// Rainforest — a raymarched forest landscape with analytic normals for the
// terrain and clouds (the trees are noise-distorted ellipsoids).
//
// Original work: "Rainforest" by Inigo Quilez (iq), 2016 —
//   https://www.shadertoy.com/view/4ttSWf
//   https://iquilezles.org/  (tutorial: https://www.youtube.com/watch?v=BFld4EBO2RE)
//
// The original source carries a restrictive license that forbids use in a
// product, altered or not. It is ported and included in Suwu with express
// permission from the author; keep that permission on file. Do not redistribute
// this file on its own terms.
//
// Adaptation notes:
//   * GLSL→WGSL: overloads get distinct names, `out` params become structs, and
//     fragment Y is flipped (WebGPU's origin is top-left, GLSL's bottom-left).
//   * The original's Buffer A + Image passes become a ping-pong accumulation
//     target (temporal reprojection, as in the demo) plus a vignette blit. The
//     camera matrix is stored in the first three texels of the accumulation
//     target, exactly as the original stores it in iChannel0.
//   * The `LOWQUALITY` path of the original is used.

struct Params {
  resolution: vec2f,
  time: f32,
  frame: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var prev_tex: texture_2d<f32>;
@group(0) @binding(2) var prev_samp: sampler;

//==========================================================================================
// general utilities
//==========================================================================================

const K_SUN_DIR = vec3f(-0.624695, 0.468521, -0.624695);
const K_MAX_TREE_HEIGHT = 4.8;
const K_MAX_HEIGHT = 840.0;

fn sd_ellipsoid_y(p: vec3f, r: vec2f) -> f32 {
  let rxyx = vec3f(r.x, r.y, r.x);
  let k0 = length(p / rxyx);
  let k1 = length(p / (rxyx * rxyx));
  return k0 * (k0 - 1.0) / k1;
}

// Returns the smoothstep value and its derivative.
fn smoothstepd(a: f32, b: f32, x_in: f32) -> vec2f {
  if (x_in < a) {
    return vec2f(0.0, 0.0);
  }
  if (x_in > b) {
    return vec2f(1.0, 0.0);
  }
  let ir = 1.0 / (b - a);
  let x = (x_in - a) * ir;
  return vec2f(x * x * (3.0 - 2.0 * x), 6.0 * x * (1.0 - x) * ir);
}

fn set_camera(ro: vec3f, ta: vec3f, cr: f32) -> mat3x3f {
  let cw = normalize(ta - ro);
  let cp = vec3f(sin(cr), cos(cr), 0.0);
  let cu = normalize(cross(cw, cp));
  let cv = normalize(cross(cu, cw));
  return mat3x3f(cu, cv, cw);
}

//==========================================================================================
// hashes (low quality, do NOT use in production)
//==========================================================================================

fn hash1_v2(p_in: vec2f) -> f32 {
  let p = 50.0 * fract(p_in * 0.3183099);
  return fract(p.x * p.y * (p.x + p.y));
}

fn hash1_f(n: f32) -> f32 {
  return fract(n * 17.0 * fract(n * 0.3183099));
}

fn hash2_v2(p: vec2f) -> vec2f {
  let k = vec2f(0.3183099, 0.3678794);
  let n = 111.0 * p.x + 113.0 * p.y;
  return fract(n * fract(k * n));
}

//==========================================================================================
// noises (value noise with analytical derivatives)
//==========================================================================================

fn noised3(x: vec3f) -> vec4f {
  let p = floor(x);
  let w = fract(x);
  let u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  let du = 30.0 * w * w * (w * (w - 2.0) + 1.0);

  let n = p.x + 317.0 * p.y + 157.0 * p.z;

  let a = hash1_f(n + 0.0);
  let b = hash1_f(n + 1.0);
  let c = hash1_f(n + 317.0);
  let d = hash1_f(n + 318.0);
  let e = hash1_f(n + 157.0);
  let f = hash1_f(n + 158.0);
  let g = hash1_f(n + 474.0);
  let h = hash1_f(n + 475.0);

  let k0 = a;
  let k1 = b - a;
  let k2 = c - a;
  let k3 = e - a;
  let k4 = a - b - c + d;
  let k5 = a - c - e + g;
  let k6 = a - b - e + f;
  let k7 = -a + b + c - d + e - f - g + h;

  return vec4f(
    -1.0 + 2.0 * (k0 + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z),
    2.0 * du * vec3f(
      k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
      k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
      k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y,
    ),
  );
}

fn noise3(x: vec3f) -> f32 {
  let p = floor(x);
  let w = fract(x);
  let u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);

  let n = p.x + 317.0 * p.y + 157.0 * p.z;

  let a = hash1_f(n + 0.0);
  let b = hash1_f(n + 1.0);
  let c = hash1_f(n + 317.0);
  let d = hash1_f(n + 318.0);
  let e = hash1_f(n + 157.0);
  let f = hash1_f(n + 158.0);
  let g = hash1_f(n + 474.0);
  let h = hash1_f(n + 475.0);

  let k0 = a;
  let k1 = b - a;
  let k2 = c - a;
  let k3 = e - a;
  let k4 = a - b - c + d;
  let k5 = a - c - e + g;
  let k6 = a - b - e + f;
  let k7 = -a + b + c - d + e - f - g + h;

  return -1.0 + 2.0 * (k0 + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z);
}

fn noised2(x: vec2f) -> vec3f {
  let p = floor(x);
  let w = fract(x);
  let u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  let du = 30.0 * w * w * (w * (w - 2.0) + 1.0);

  let a = hash1_v2(p + vec2f(0.0, 0.0));
  let b = hash1_v2(p + vec2f(1.0, 0.0));
  let c = hash1_v2(p + vec2f(0.0, 1.0));
  let d = hash1_v2(p + vec2f(1.0, 1.0));

  let k0 = a;
  let k1 = b - a;
  let k2 = c - a;
  let k4 = a - b - c + d;

  return vec3f(
    -1.0 + 2.0 * (k0 + k1 * u.x + k2 * u.y + k4 * u.x * u.y),
    2.0 * du * vec2f(k1 + k4 * u.y, k2 + k4 * u.x),
  );
}

fn noise2(x: vec2f) -> f32 {
  let p = floor(x);
  let w = fract(x);
  let u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);

  let a = hash1_v2(p + vec2f(0.0, 0.0));
  let b = hash1_v2(p + vec2f(1.0, 0.0));
  let c = hash1_v2(p + vec2f(0.0, 1.0));
  let d = hash1_v2(p + vec2f(1.0, 1.0));

  return -1.0 + 2.0 * (a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y);
}

//==========================================================================================
// fbm constructions
//==========================================================================================

const M3 = mat3x3f(
  vec3f(0.00, 0.80, 0.60),
  vec3f(-0.80, 0.36, -0.48),
  vec3f(-0.60, -0.48, 0.64),
);
const M3I = mat3x3f(
  vec3f(0.00, -0.80, -0.60),
  vec3f(0.80, 0.36, -0.48),
  vec3f(0.60, -0.48, 0.64),
);
const M2 = mat2x2f(vec2f(0.80, 0.60), vec2f(-0.60, 0.80));
const M2I = mat2x2f(vec2f(0.80, -0.60), vec2f(0.60, 0.80));
const MAT3_IDENTITY = mat3x3f(
  vec3f(1.0, 0.0, 0.0),
  vec3f(0.0, 1.0, 0.0),
  vec3f(0.0, 0.0, 1.0),
);
const MAT2_IDENTITY = mat2x2f(vec2f(1.0, 0.0), vec2f(0.0, 1.0));

fn fbm4_2(x_in: vec2f) -> f32 {
  let f = 1.9;
  let s = 0.55;
  var a = 0.0;
  var b = 0.5;
  var x = x_in;
  for (var i = 0; i < 4; i = i + 1) {
    let n = noise2(x);
    a = a + b * n;
    b = b * s;
    x = (f * M2) * x;
  }
  return a;
}

fn fbm4_3(x_in: vec3f) -> f32 {
  let f = 2.0;
  let s = 0.5;
  var a = 0.0;
  var b = 0.5;
  var x = x_in;
  for (var i = 0; i < 4; i = i + 1) {
    let n = noise3(x);
    a = a + b * n;
    b = b * s;
    x = (f * M3) * x;
  }
  return a;
}

fn fbmd7(x_in: vec3f) -> vec4f {
  let f = 1.92;
  let s = 0.5;
  var a = 0.0;
  var b = 0.5;
  var d = vec3f(0.0);
  var m = MAT3_IDENTITY;
  var x = x_in;
  for (var i = 0; i < 7; i = i + 1) {
    let n = noised3(x);
    a = a + b * n.x;
    d = d + b * (m * n.yzw);
    b = b * s;
    x = (f * M3) * x;
    m = (f * M3I) * m;
  }
  return vec4f(a, d);
}

fn fbmd8(x_in: vec3f) -> vec4f {
  let f = 2.0;
  let s = 0.65;
  var a = 0.0;
  var b = 0.5;
  var d = vec3f(0.0);
  var m = MAT3_IDENTITY;
  var x = x_in;
  for (var i = 0; i < 8; i = i + 1) {
    let n = noised3(x);
    a = a + b * n.x;
    if (i < 4) {
      d = d + b * (m * n.yzw);
    }
    b = b * s;
    x = (f * M3) * x;
    m = (f * M3I) * m;
  }
  return vec4f(a, d);
}

fn fbm9(x_in: vec2f) -> f32 {
  let f = 1.9;
  let s = 0.55;
  var a = 0.0;
  var b = 0.5;
  var x = x_in;
  for (var i = 0; i < 9; i = i + 1) {
    let n = noise2(x);
    a = a + b * n;
    b = b * s;
    x = (f * M2) * x;
  }
  return a;
}

fn fbmd9(x_in: vec2f) -> vec3f {
  let f = 1.9;
  let s = 0.55;
  var a = 0.0;
  var b = 0.5;
  var d = vec2f(0.0);
  var m = MAT2_IDENTITY;
  var x = x_in;
  for (var i = 0; i < 9; i = i + 1) {
    let n = noised2(x);
    a = a + b * n.x;
    d = d + b * (m * n.yz);
    b = b * s;
    x = (f * M2) * x;
    m = (f * M2I) * m;
  }
  return vec3f(a, d);
}

//==========================================================================================
// specifics to the actual painting
//==========================================================================================

fn fog(col: vec3f, t: f32) -> vec3f {
  let ext = exp2(-t * 0.00025 * vec3f(1.0, 1.5, 4.0));
  return col * ext + (1.0 - ext) * vec3f(0.55, 0.55, 0.58);
}

//------------------------------------------------------------------------------------------
// clouds
//------------------------------------------------------------------------------------------

fn clouds_fbm(pos: vec3f) -> vec4f {
  let time = params.time;
  return fbmd8(pos * 0.0015 + vec3f(2.0, 1.1, 1.0) + 0.07 * vec3f(time, 0.5 * time, -0.15 * time));
}

struct CloudSample {
  d: f32,
  gra: vec3f,
  nnd: f32,
}

fn clouds_map(pos: vec3f) -> CloudSample {
  var d = abs(pos.y - 900.0) - 40.0;
  var gra = vec3f(0.0, sign(pos.y - 900.0), 0.0);

  let n = clouds_fbm(pos);
  d = d + 400.0 * n.x * (0.7 + 0.3 * gra.y);

  if (d > 0.0) {
    return CloudSample(-d, vec3f(0.0), 0.0);
  }

  let nnd = -d;
  d = min(-d / 100.0, 0.25);
  return CloudSample(d, gra, nnd);
}

fn clouds_shadow_flat(ro: vec3f, rd: vec3f) -> f32 {
  let t = (900.0 - ro.y) / rd.y;
  if (t < 0.0) {
    return 1.0;
  }
  let pos = ro + rd * t;
  return clouds_fbm(pos).x;
}

struct CloudResult {
  color: vec3f,
  alpha: f32,
  resT: f32,
}

fn render_clouds(ro: vec3f, rd: vec3f, tmin_in: f32, tmax_in: f32, resT_in: f32) -> CloudResult {
  var sum = vec4f(0.0);
  var tmin = tmin_in;
  var tmax = tmax_in;
  var resT = resT_in;

  // Bounding volume.
  let tl = (600.0 - ro.y) / rd.y;
  let th = (1200.0 - ro.y) / rd.y;
  if (tl > 0.0) {
    tmin = max(tmin, tl);
  } else {
    return CloudResult(sum.xyz, sum.w, resT);
  }
  if (th > 0.0) {
    tmax = min(tmax, th);
  }

  var t = tmin;
  var lastT = -1.0;
  var thickness = 0.0;
  for (var i = 0; i < 128; i = i + 1) {
    let pos = ro + t * rd;
    let sample = clouds_map(pos);
    let den = sample.d;
    var dt = max(0.2, 0.011 * t);

    if (den > 0.001) {
      let kk = clouds_map(pos + K_SUN_DIR * 70.0).nnd;
      var sha = 1.0 - smoothstep(-200.0, 200.0, kk);
      sha = sha * 1.5;

      let nor = normalize(sample.gra);
      let dif = clamp(0.4 + 0.6 * dot(nor, K_SUN_DIR), 0.0, 1.0) * sha;
      let fre = clamp(1.0 + dot(nor, rd), 0.0, 1.0) * sha;
      let occ = 0.2 + 0.7 * max(1.0 - kk / 200.0, 0.0) + 0.1 * (1.0 - den);

      var lin = vec3f(0.0);
      lin = lin + vec3f(0.70, 0.80, 1.00) * 1.0 * (0.5 + 0.5 * nor.y) * occ;
      lin = lin + vec3f(0.10, 0.40, 0.20) * 1.0 * (0.5 - 0.5 * nor.y) * occ;
      lin = lin + vec3f(1.00, 0.95, 0.85) * 3.0 * dif * occ + 0.1;

      var col = vec3f(0.8, 0.8, 0.8) * 0.45;
      col = col * lin;
      col = fog(col, t);

      // Front-to-back blending.
      let alp = clamp(den * 0.5 * 0.125 * dt, 0.0, 1.0);
      sum = sum + vec4f(col * alp, alp) * (1.0 - sum.w);

      thickness = thickness + dt * den;
      if (lastT < 0.0) {
        lastT = t;
      }
    } else {
      dt = abs(den) + 0.2;
    }

    t = t + dt;
    if (sum.w > 0.995 || t > tmax) {
      break;
    }
  }

  if (lastT > 0.0) {
    resT = min(resT, lastT);
  }

  sum = vec4f(
    sum.xyz + max(0.0, 1.0 - 0.0125 * thickness) * vec3f(1.00, 0.60, 0.40) * 0.3 * pow(clamp(dot(K_SUN_DIR, rd), 0.0, 1.0), 32.0),
    sum.w,
  );

  return CloudResult(clamp(sum.xyz, vec3f(0.0), vec3f(1.0)), clamp(sum.w, 0.0, 1.0), resT);
}

//------------------------------------------------------------------------------------------
// terrain
//------------------------------------------------------------------------------------------

fn terrain_map(p: vec2f) -> vec2f {
  var e = fbm9(p / 2000.0 + vec2f(1.0, -2.0));
  let a = 1.0 - smoothstep(0.12, 0.13, abs(e + 0.12));
  e = 600.0 * e + 600.0;

  // Cliff.
  e = e + 90.0 * smoothstep(552.0, 594.0, e);

  return vec2f(e, a);
}

fn terrain_map_d(p: vec2f) -> vec4f {
  var e = fbmd9(p / 2000.0 + vec2f(1.0, -2.0));
  e.x = 600.0 * e.x + 600.0;
  e.y = 600.0 * e.y;
  e.z = 600.0 * e.z;

  // Cliff (with chain rule for the derivative).
  let c = smoothstepd(550.0, 600.0, e.x);
  e.x = e.x + 90.0 * c.x;
  e.y = e.y + 90.0 * c.y * e.y;
  e.z = e.z + 90.0 * c.y * e.z;

  e.y = e.y / 2000.0;
  e.z = e.z / 2000.0;
  return vec4f(e.x, normalize(vec3f(-e.y, 1.0, -e.z)));
}

fn terrain_normal(pos: vec2f) -> vec3f {
  return terrain_map_d(pos).yzw;
}

fn terrain_shadow(ro: vec3f, rd: vec3f, mint: f32) -> f32 {
  var res = 1.0;
  var t = mint;
  for (var i = 0; i < 32; i = i + 1) {
    let pos = ro + t * rd;
    let env = terrain_map(pos.xz);
    let hei = pos.y - env.x;
    res = min(res, 32.0 * hei / t);
    if (res < 0.0001 || pos.y > K_MAX_HEIGHT) {
      break;
    }
    t = t + clamp(hei, 2.0 + t * 0.1, 100.0);
  }
  return clamp(res, 0.0, 1.0);
}

fn raymarch_terrain(ro: vec3f, rd: vec3f, tmin: f32, tmax_in: f32) -> vec2f {
  // Bounding plane.
  var tmax = tmax_in;
  let tp = (K_MAX_HEIGHT + K_MAX_TREE_HEIGHT - ro.y) / rd.y;
  if (tp > 0.0) {
    tmax = min(tmax, tp);
  }

  var t2 = -1.0;
  var t = tmin;
  var ot = t;
  var odis = 0.0;
  var odis2 = 0.0;
  var dis = 0.0;
  var th = 0.0;

  for (var i = 0; i < 400; i = i + 1) {
    th = 0.001 * t;

    let pos = ro + t * rd;
    let env = terrain_map(pos.xz);
    let hei = env.x;

    // Tree envelope.
    let dis2 = pos.y - (hei + K_MAX_TREE_HEIGHT * 1.1);
    if (dis2 < th) {
      if (t2 < 0.0) {
        t2 = ot + (th - odis2) * (t - ot) / (dis2 - odis2);
      }
    }
    odis2 = dis2;

    // Terrain.
    dis = pos.y - hei;
    if (dis < th) {
      break;
    }

    ot = t;
    odis = dis;
    t = t + dis * 0.8 * (1.0 - 0.75 * env.y);
    if (t > tmax) {
      break;
    }
  }

  if (t > tmax) {
    t = -1.0;
  } else {
    t = ot + (th - odis) * (t - ot) / (dis - odis);
  }

  return vec2f(t, t2);
}

//------------------------------------------------------------------------------------------
// trees
//------------------------------------------------------------------------------------------

struct TreeSample {
  d: f32,
  hei: f32,
  matId: f32,
  dis: f32,
}

fn trees_map(p_in: vec3f, rt: f32) -> TreeSample {
  var hei = 1.0;
  var matId = 0.0;
  var dis = 0.0;

  let base = terrain_map(p_in.xz).x;
  let bb = fbm4_2(p_in.xz * 0.075);

  var d = 20.0;
  let n = floor(p_in.xz / 2.0);
  let f = fract(p_in.xz / 2.0);
  for (var j = 0; j <= 1; j = j + 1) {
    for (var i = 0; i <= 1; i = i + 1) {
      let g = vec2f(f32(i), f32(j)) - step(f, vec2f(0.5));
      let o = hash2_v2(n + g);
      let v = hash2_v2(n + g + vec2f(13.1, 71.7));
      let r = g - f + o;

      var height = K_MAX_TREE_HEIGHT * (0.4 + 0.8 * v.x);
      var width = 0.5 + 0.2 * v.x + 0.3 * v.y;

      if (bb < 0.0) {
        width = width * 0.5;
      } else {
        height = height * 0.7;
      }

      let q = vec3f(r.x, p_in.y - base - height * 0.5, r.y);
      let k = sd_ellipsoid_y(q, vec2f(width, 0.5 * height));

      if (k < d) {
        d = k;
        matId = 0.5 * hash1_v2(n + g + 111.0);
        if (bb > 0.0) {
          matId = matId + 0.5;
        }
        hei = (p_in.y - base) / height;
        hei = hei * (0.5 + 0.5 * length(q) / width);
      }
    }
  }

  // Distort the ellipsoids to read as trees (mainly in the distance).
  if (rt < 1200.0) {
    let pd = vec3f(p_in.x, p_in.y - 600.0, p_in.z);
    var s = fbm4_3(pd * 3.0);
    s = s * s;
    let att = 1.0 - smoothstep(100.0, 1200.0, rt);
    d = d + 4.0 * s * att;
    dis = s * att;
  }

  return TreeSample(d, hei, matId, dis);
}

fn trees_shadow(ro: vec3f, rd: vec3f) -> f32 {
  var res = 1.0;
  var t = 0.02;
  for (var i = 0; i < 64; i = i + 1) {
    let pos = ro + rd * t;
    let h = trees_map(pos, t).d;
    res = min(res, 32.0 * h / t);
    t = t + h;
    if (res < 0.001 || t > 50.0 || pos.y > K_MAX_HEIGHT + K_MAX_TREE_HEIGHT) {
      break;
    }
  }
  return clamp(res, 0.0, 1.0);
}

fn trees_normal(pos: vec3f, t: f32) -> vec3f {
  var n = vec3f(0.0);
  for (var i = 0; i < 4; i = i + 1) {
    let e = 0.5773 * (2.0 * vec3f(f32(((i + 3) >> 1) & 1), f32((i >> 1) & 1), f32(i & 1)) - 1.0);
    n = n + e * trees_map(pos + 0.005 * e, t).d;
  }
  return normalize(n);
}

//------------------------------------------------------------------------------------------
// sky
//------------------------------------------------------------------------------------------

fn render_sky(ro: vec3f, rd: vec3f) -> vec3f {
  var col = vec3f(0.42, 0.62, 1.1) - rd.y * 0.4;

  // Clouds (flat, on the background).
  let t = (2500.0 - ro.y) / rd.y;
  if (t > 0.0) {
    let uv = (ro + t * rd).xz;
    let cl = fbm9(uv * 0.00104);
    let dl = smoothstep(-0.2, 0.6, cl);
    col = mix(col, vec3f(1.0), 0.12 * dl);
  }

  // Sun glare.
  let sun = clamp(dot(K_SUN_DIR, rd), 0.0, 1.0);
  col = col + 0.2 * vec3f(1.0, 0.6, 0.3) * pow(sun, 32.0);
  return col;
}

//==========================================================================================
// main image making function
//==========================================================================================

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let res = params.resolution;
  let time = params.time;

  let o = hash2_v2(vec2f(params.frame, 1.0)) - 0.5;

  // GLSL fragment coordinates are bottom-up; WebGPU's are top-down.
  let frag_coord = vec2f(position.x, res.y - position.y);
  let p = (2.0 * (frag_coord + o) - res) / res.y;

  // Camera.
  var ro = vec3f(0.0, 401.5, 6.0);
  var ta = vec3f(0.0, 403.5, -90.0 + ro.z);
  ro.x = ro.x - 80.0 * sin(0.01 * time);
  ta.x = ta.x - 86.0 * sin(0.01 * time);

  let ca = set_camera(ro, ta, 0.0);
  let rd = ca * normalize(vec3f(p, 1.5));

  var resT = 2000.0;

  // Sky.
  var col = render_sky(ro, rd);

  // Raycast terrain and the tree envelope.
  var obj = 0;
  let t = raymarch_terrain(ro, rd, 15.0, 2000.0);
  if (t.x > 0.0) {
    resT = t.x;
    obj = 1;
  }

  // Raycast the trees, if needed.
  var treeSample = TreeSample(0.0, 1.0, 0.0, 0.0);
  if (t.y > 0.0) {
    var tf = t.y;
    let tfMax = select(2000.0, t.x, t.x > 0.0);
    for (var i = 0; i < 64; i = i + 1) {
      let pos = ro + tf * rd;
      treeSample = trees_map(pos, tf);
      if (treeSample.d < 0.000125 * tf) {
        break;
      }
      tf = tf + treeSample.d;
      if (tf > tfMax) {
        break;
      }
    }
    if (tf < tfMax) {
      resT = tf;
      obj = 2;
    }
  }

  // Shade.
  if (obj > 0) {
    let pos = ro + resT * rd;
    let epos = pos + vec3f(0.0, 4.8, 0.0);

    var sha1 = terrain_shadow(pos + vec3f(0.0, 0.02, 0.0), K_SUN_DIR, 0.02);
    sha1 = sha1 * smoothstep(-0.325, -0.075, clouds_shadow_flat(epos, K_SUN_DIR));

    let tnor = terrain_normal(pos.xz);
    var nor = vec3f(0.0);
    var speC = vec3f(1.0);

    if (obj == 1) {
      // Terrain.
      nor = normalize(tnor + 0.8 * (1.0 - abs(tnor.y)) * 0.8 * fbmd7((pos - vec3f(0.0, 600.0, 0.0)) * 0.15 * vec3f(1.0, 0.2, 1.0)).yzw);

      col = vec3f(0.18, 0.12, 0.10) * 0.85;
      col = 1.0 * mix(col, vec3f(0.1, 0.1, 0.0) * 0.2, smoothstep(0.7, 0.9, nor.y));

      var dif = clamp(dot(nor, K_SUN_DIR), 0.0, 1.0);
      dif = dif * sha1;

      let bac = clamp(dot(normalize(vec3f(-K_SUN_DIR.x, 0.0, -K_SUN_DIR.z)), nor), 0.0, 1.0);
      let foc = clamp((pos.y / 2.0 - 180.0) / 130.0, 0.0, 1.0);
      let dom = clamp(0.5 + 0.5 * nor.y, 0.0, 1.0);
      var lin = 1.0 * 0.2 * mix(0.1 * vec3f(0.1, 0.2, 0.1), vec3f(0.7, 0.9, 1.5) * 3.0, dom) * foc;
      lin = lin + 1.0 * 8.5 * vec3f(1.0, 0.9, 0.8) * dif;
      lin = lin + 1.0 * 0.27 * vec3f(1.1, 1.0, 0.9) * bac * foc;
      speC = vec3f(4.0) * dif * (1.0 - smoothstep(0.0, 20.0, abs(pos.y / 2.0 - 310.0) - 20.0));
      col = col * lin;
    } else {
      // Trees.
      let gnor = trees_normal(pos, resT);
      nor = normalize(gnor + 2.0 * tnor);

      let occ = clamp(treeSample.hei, 0.0, 1.0) * pow(1.0 - 2.0 * treeSample.dis, 3.0);

      var dif = clamp(0.1 + 0.9 * dot(nor, K_SUN_DIR), 0.0, 1.0);
      dif = dif * sha1;
      if (dif > 0.0001) {
        var a = clamp(0.5 + 0.5 * dot(tnor, K_SUN_DIR), 0.0, 1.0);
        a = a * a;
        a = a * occ;
        a = a * 0.6;
        a = a * smoothstep(60.0, 200.0, resT);
        // Tree shadows with fake transmission.
        let sha2 = trees_shadow(pos + K_SUN_DIR * 0.1, K_SUN_DIR);
        dif = dif * (a + (1.0 - a) * sha2);
      }

      let dom = clamp(0.5 + 0.5 * nor.y, 0.0, 1.0);
      let bac = clamp(0.5 + 0.5 * dot(normalize(vec3f(-K_SUN_DIR.x, 0.0, -K_SUN_DIR.z)), nor), 0.0, 1.0);
      let fre = clamp(1.0 + dot(nor, rd), 0.0, 1.0);

      var lin = 12.0 * vec3f(1.2, 1.0, 0.7) * dif * occ * (2.5 - 1.5 * smoothstep(0.0, 120.0, resT));
      lin = lin + 0.55 * mix(0.1 * vec3f(0.1, 0.2, 0.0), vec3f(0.6, 1.0, 1.0), dom * occ);
      lin = lin + 0.07 * vec3f(1.0, 1.0, 0.9) * bac * occ;
      lin = lin + 1.10 * vec3f(0.9, 1.0, 0.8) * pow(fre, 5.0) * occ * (1.0 - smoothstep(100.0, 200.0, resT));
      speC = dif * vec3f(1.0, 1.1, 1.5) * 1.2;

      // Material.
      let brownAreas = fbm4_2(pos.zx * 0.015);
      col = vec3f(0.2, 0.2, 0.05);
      col = mix(col, vec3f(0.32, 0.2, 0.05), smoothstep(0.2, 0.9, fract(2.0 * treeSample.matId)));
      col = col * select(
        1.0,
        0.65 + 0.35 * smoothstep(300.0, 600.0, resT) * (1.0 - smoothstep(500.0, 700.0, pos.y)),
        treeSample.matId < 0.5,
      );
      col = mix(col, vec3f(0.25, 0.16, 0.01) * 0.825, 0.7 * smoothstep(0.1, 0.3, brownAreas) * smoothstep(0.5, 0.8, tnor.y));
      col = col * (1.0 - 0.5 * smoothstep(400.0, 700.0, pos.y));
      col = col * lin;
    }

    // Specular.
    let refv = reflect(rd, nor);
    let fre = clamp(1.0 + dot(nor, rd), 0.0, 1.0);
    let spe = 3.0 * pow(clamp(dot(refv, K_SUN_DIR), 0.0, 1.0), 9.0) * (0.05 + 0.95 * pow(fre, 5.0));
    col = col + spe * speC;

    col = fog(col, resT);
  }

  // Clouds.
  var isCloud = 0.0;
  {
    let cres = render_clouds(ro, rd, 0.0, resT, resT);
    col = col * (1.0 - cres.alpha) + cres.color;
    isCloud = cres.alpha;
    resT = cres.resT;
  }

  // Final grading.
  let sun = clamp(dot(K_SUN_DIR, rd), 0.0, 1.0);
  col = col + 0.25 * vec3f(0.8, 0.4, 0.2) * pow(sun, 4.0);
  col = pow(clamp(col * 1.1 - 0.02, vec3f(0.0), vec3f(1.0)), vec3f(0.4545));
  col = col * col * (3.0 - 2.0 * col);
  col = pow(col, vec3f(1.0, 0.92, 1.0));
  col = col * vec3f(1.02, 0.99, 0.9);
  col.z = col.z + 0.1;

  // Reproject from the previous frame and average, using the camera matrix the
  // previous frame stored in the first three texels of its bottom row (GL
  // fragCoord.y == 0).
  let cy = i32(res.y) - 1;
  let old0 = textureLoad(prev_tex, vec2i(0, cy), 0);
  let old1 = textureLoad(prev_tex, vec2i(1, cy), 0);
  let old2 = textureLoad(prev_tex, vec2i(2, cy), 0);

  let wpos = vec4f(ro + rd * resT, 1.0);
  let cpos = vec3f(dot(wpos, old0), dot(wpos, old1), dot(wpos, old2));
  let npos = 1.5 * cpos.xy / cpos.z;
  // `spos`/`rpos` stay in the original GL (bottom-up) space; the texture is
  // top-down, so only the sampling coordinate is flipped.
  var spos = 0.5 + 0.5 * npos * vec2f(res.y / res.x, 1.0);
  spos = spos - o / res;
  let rpos = spos * res;

  if (rpos.y < 1.0 && rpos.x < 3.0) {
    // This pixel holds the camera data — leave the traced color.
  } else {
    var ocol = textureSampleLevel(prev_tex, prev_samp, vec2f(spos.x, 1.0 - spos.y), 0.0).xyz;
    if (params.frame == 0.0) {
      ocol = col;
    }
    col = mix(ocol, col, 0.1 + 0.8 * isCloud);
  }

  // Store this frame's camera matrix in the first three texels.
  let ip = vec2i(frag_coord);
  if (ip.y == 0 && ip.x <= 2) {
    var c = ca[0];
    if (ip.x == 1) {
      c = ca[1];
    } else if (ip.x == 2) {
      c = ca[2];
    }
    return vec4f(c, -dot(c, ro));
  }

  return vec4f(col, 1.0);
}
