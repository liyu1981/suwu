// Shared math for the Monomino Domino Tile Traversal port.
//
// The original's "Common" tab: the integer hashes, the four link directions
// that drive the tiling, and the Cook-Torrance BRDF the image pass lights with.
// The back-buffer pass (tiling.wgsl) and the raymarch (scene.wgsl) both import
// from here, so a cell's random direction and its rendered shape always agree.
//
// Ported from "Monomino Domino Tile Traversal" by Shane,
// https://www.shadertoy.com/view/l3sBzM (Shadertoy).

// -- Constants ---------------------------------------------------------------

// Back-buffer grid: 32×32 cells of state.
export const GRID_SIZE: f32 = 32.0;
export const PI: f32 = 3.14159265;

// -- Helpers ----------------------------------------------------------------

// GLSL's mod(): the floor-based, always-positive remainder. Cell IDs go
// negative whenever the camera drifts past the origin, and WGSL's `%` does not
// wrap the same way.
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

// -- Integer hashes ----------------------------------------------------------

// Fabrice's fork of "Integer Hash - III" by IQ: https://shadertoy.com/view/4tXyWN
export fn hash21(f: vec2f) -> f32 {
  var p = bitcast<vec2<u32>>(f);
  p = 1664525u * ((p >> vec2<u32>(1u)) ^ p.yx);
  return f32(1103515245u * (p.x ^ (p.y >> 3u))) / f32(0xffffffffu);
}

// IQ's "uint" based uvec3 to float hash.
export fn hash31(f: vec3f) -> f32 {
  var p = bitcast<vec3<u32>>(f);
  p = 1103515245u * ((p >> vec3<u32>(2u)) ^ (p.yzx >> vec3<u32>(1u)) ^ p.zxy);
  let h32 = 1103515245u * ((p.x ^ (p.y >> 3u)) ^ (p.z >> 6u));
  let n = h32 ^ (h32 >> 16u);
  return f32(n & 0x7fffffffu) / f32(0x7fffffffu);
}

// A slight reworking of Nimitz's "Quality hashes collection" (based on the
// same integer hash): one scramble, then four decorrelated components.
export fn hash42(f: vec2f) -> vec4f {
  var p = bitcast<vec2<u32>>(f);
  p = 1664525u * ((p >> vec2<u32>(1u)) ^ p.yx);
  var n = 1103515245u * (p.x ^ (p.y >> 3u));
  n = n ^ (n >> 16u);
  let rz = vec4<u32>(n, n * 16807u, n * 48271u, n * 69621u);
  return vec4f((rz >> vec4<u32>(1u)) & vec4<u32>(0x7fffffffu)) / f32(0x7fffffffu);
}

// -- Link directions ---------------------------------------------------------

// The four direction vectors: left, up, right, down.
export fn e_dirs() -> array<vec2f, 4> {
  return array<vec2f, 4>(vec2f(-1.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(0.0, -1.0));
}

// Converts 0, 1, 2 or 3 to the left, up, right, down vectors respectively.
export fn index_to_dir(i: f32) -> vec2f {
  let e = e_dirs();
  return e[i32(i)];
}

// Converts the left, up, right, down vectors to 0, 1, 2 or 3 respectively.
export fn dir_to_index(u: vec2f) -> f32 {
  let e = e_dirs();
  for (var i = 0; i < 4; i++) {
    if (u.x == e[i].x && u.y == e[i].y) {
      return f32(i);
    }
  }
  return 4.0;
}

// A random number based on 2D position and time (frame).
export fn rnd_dir_index(ut: vec3f) -> f32 {
  return wrap1(floor(64.0 * hash31(ut)), 4.0);
}

// A random direction.
export fn rnd_dir(u: vec3f) -> vec2f {
  return index_to_dir(rnd_dir_index(u));
}

// -- Cook-Torrance BRDF ------------------------------------------------------
//
// Microfacet BRDF: theory and implementation of basic PBR materials —
// https://www.youtube.com/watch?v=gya7x9H3mV0

// Microfaceted normal distribution function.
fn d_ggx(no_h: f32, roughness: f32) -> f32 {
  let alpha = pow(roughness, 4.0);
  let b = no_h * no_h * (alpha - 1.0) + 1.0;
  return alpha / (PI * b * b);
}

// Surface geometry function (Disney remapping).
fn g1_ggx_schlick(no_v: f32, roughness: f32) -> f32 {
  let r = 0.5 + 0.5 * roughness;
  let k = (r * r) / 2.0;
  let denom = no_v * (1.0 - k) + k;
  return max(no_v, 0.001) / denom;
}

fn g_smith(no_v: f32, no_l: f32, roughness: f32) -> f32 {
  let g1_l = g1_ggx_schlick(no_l, roughness);
  let g1_v = g1_ggx_schlick(no_v, roughness);
  return g1_l * g1_v;
}

// Bidirectional Reflectance Distribution Function. `kind` is 0 for dielectics,
// 1 for metals; `fres_ref` the dielectric reflectance; `sp_col` the specular
// tint.
export fn brdf(
  col: vec3f,
  n: vec3f,
  l: vec3f,
  v: vec3f,
  kind: f32,
  rough: f32,
  fres_ref: f32,
  sp_col: vec3f,
) -> vec3f {
  let h = normalize(v + l); // Half vector.

  let nv = clamp(dot(n, v), 0.0, 1.0);
  let nl = clamp(dot(n, l), 0.0, 1.0);
  let nh = clamp(dot(n, h), 0.0, 1.0);
  let vh = clamp(dot(v, h), 0.0, 1.0);

  // F0 for dielectics in range [0., .16]; for metals, the base color is used.
  var f0 = vec3f(0.16 * (fres_ref * fres_ref));
  f0 = mix(f0, col, kind);
  let fr = f0 + (1.0 - f0) * pow(1.0 - vh, 5.0); // Fresnel-Schlick.
  let d = d_ggx(nh, rough); // Microfacet distribution — the dominant term.
  let g = g_smith(nv, nl, rough); // Geometry self-shadowing.
  let spec = fr * d * g / (4.0 * max(nv, 0.001));

  var diff = vec3f(nl);
  diff *= 1.0 - fr; // If not specular, use as diffuse.
  diff *= 1.0 - kind; // No diffuse for metals.

  return col * diff + sp_col * spec * PI;
}
