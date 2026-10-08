// Scene pass of the Hexagon Landscape port: raymarched extruded hexagons.
//
// Ported to WGSL/vgpu from "Asymmetric Hexagon Landscape" by Shane,
// https://www.shadertoy.com/view/tdtyDs (Shadertoy).
//
// Adaptation notes:
//   * The original renders its distance field and height map into a cube-map
//     buffer once (field.wgsl / height.wgsl here) and reads them with
//     textureLod; both become plain textureLoad()s of the two baked tiles the
//     host fills on its first frame.
//   * `iChannel1`, the tri-planar surface texture, ships as an asset on
//     Shadertoy. Nothing is shipped here: the same planar weighting is applied
//     to a value-noise slab instead (triPlanar below).
//   * Fragment Y is flipped: WebGPU's origin is top-left, GLSL's is bottom-left.
//   * The march renders into an offscreen target capped by the host (the
//     `detail` setting) and is blitted to the canvas, so the 96-step march
//     never over-spends pixels on a high-DPR display.
//   * The host scales `time` by the user's animation-speed setting; every
//     time-driven term in the original (camera, water, fog) reads it.

import {
  FIELD_SIZE,
  GSCALE,
  HEIGHT_WRAP,
  HS,
  LEVELS,
  WLEV,
  hash21,
  offset_verts,
  op_extrusion,
  path,
  rot2,
  s_box,
  wrap1,
  wrap4,
} from "./common.wgsl";

// -- Bindings ---------------------------------------------------------------

struct Params {
  resolution: vec2f,
  time: f32,
  _pad: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
// Baked distance field: four hexagon distances per world-space tile.
@group(0) @binding(1) var field_tex: texture_2d<f32>;
// Baked height map, one tile of gradient noise.
@group(0) @binding(2) var height_tex: texture_2d<f32>;

// -- Constants ---------------------------------------------------------------

// Max ray distance.
const FAR: f32 = 20.0;
// Height the water surface sits at, in quantized levels.
const WLEV_LEVEL: f32 = WLEV / LEVELS;
// One window storey, in world units: two half-levels of the extrusion.
const WINDOW_PERIOD: f32 = 0.6 * 2.0 / LEVELS;
// Scene object IDs.
const OBJ_BLOCKS: f32 = 0.0;
const OBJ_FLOOR: f32 = 1.0;

// -- Globals ----------------------------------------------------------------
//
// The original keeps these in GLSL globals between map() and mainImage: the
// winning block's identity has to survive the trace, while the normal, shadow
// and AO walks keep overwriting it.

var<private> g_v: array<vec4f, 3>;
var<private> g_p: vec2f;
var<private> d2d: f32;
var<private> g_id: vec4f;
var<private> obj_id: f32;

// -- Cached field lookups ---------------------------------------------------

// The distance field of the four hexagons covering world point q. The tile
// wraps with fract(); the 1024th-grid quantization matches the original
// (floor(q*1024) texels, nearest sampling).
fn tx_field(q: vec2f) -> vec4f {
  let texel = vec2i(floor(fract(q) * FIELD_SIZE));
  return textureLoad(field_tex, texel, 0);
}

// The baked height at a (wrapped) height-map coordinate.
fn tx_height(p: vec2f) -> f32 {
  let texel = vec2i(floor(fract(p) * FIELD_SIZE));
  return textureLoad(height_tex, texel, 0).x;
}

// -- Height -----------------------------------------------------------------

// Height of the block at world position idi: read from the baked noise, wrap
// the valley around the camera path, carve the path out of it, then quantize to
// LEVELS so windows line up with the terraced levels. Returns a value in level
// units, floored at the water level (the extrusion applies HS later).
fn hm_block(idi: vec2f) -> f32 {
  var p = idi;

  // Wrapping things around the camera path.
  let pth = path(p.y); // y is the travel axis here.
  p -= pth;

  // Distance from the path center, before the wrap.
  let d = abs((p.x + 0.5) - 0.5) * 2.0;

  // Snap to the height-map tile (the original divides by 16 and samples with
  // nearest filtering).
  p /= HEIGHT_WRAP;
  var h = tx_height(p);

  // Carving out a path.
  h = mix(h + pth.y, h / 1.5 + pth.y / 2.0, 1.0 - smoothstep(0.0, 0.75, d - 0.15));

  // Quantizing the height levels: more expensive, but it looks neater —
  // windows line up with the terraced levels, etc.
  h = floor(h * (LEVELS + 0.999)) / LEVELS;
  h = max(h, WLEV_LEVEL);
  return h;
}

// -- Scene ------------------------------------------------------------------

// A regular extruded block grid: pull the four candidate hexagons' cached
// distances, extrude each to its height, and keep the nearest. Comparing all
// four extruded blocks is required — the minimum 2D distance alone does not
// give the minimum extruded distance.
fn blocks(q: vec3f) -> vec4f {
  let p40 = tx_field(q.xy);

  let dim = vec2f(GSCALE, GSCALE);
  // Repeat cell size.
  let s = dim * 2.0;
  let centers = cell_centers();

  var d = 1e5;
  var id = vec2f(0);
  var hex_h = 0.0;

  d2d = 1e5;
  g_v = array<vec4f, 3>(vec4f(0), vec4f(0), vec4f(0));
  g_p = vec2f(0);

  for (var i = 0; i < 4; i++) {
    let cntr = centers[i] / 2.0;

    var p = q.xy;
    let ip = floor(p / s - cntr) + 0.5;
    p -= (ip + cntr) * s;
    let idi = ip + cntr;

    // Cached distance of this block's rounded offset hexagon.
    let face = p40[i];

    // Height (level units), read from the baked height map at the block's
    // world position — the ID is scaled into world space first, as in the
    // original.
    let wid = idi * s;
    var h1 = hm_block(wid);

    // Quantized water: each water block bobs independently.
    if (h1 <= WLEV_LEVEL + 0.001) {
      let sf = dot(sin(wid * 8.0 - cos(wid.yx * 16.0 + params.time * 2.0)), vec2f(0.012)) - 0.024;
      h1 += sf;
    }

    h1 *= HS; // Height scaling.

    // Extruded offset hexagon.
    var face_ext = op_extrusion(face, q.z - h1, h1);
    face_ext += max(face, -0.015) * 0.5;

    // Adding the top to the higher pylons to act as roofs (the non-`ARID`
    // variant of the original).
    if (h1 > 0.4) {
      face_ext += face * (h1 * 0.6 + 0.25);
    }

    if (face_ext < d) {
      d = face_ext;
      id = wid;
      hex_h = h1;

      // The vertices are only needed for the winning block: the raymarch reads
      // distances from the cache, and the shading stage paints windows on the
      // winner's sides.
      g_v = offset_verts(idi);
      g_p = p;
      d2d = face;
    }
  }

  return vec4f(d, id, hex_h);
}

// The four hexagon cell centers of one repeat cell, flat-top arrangement.
fn cell_centers() -> array<vec2f, 4> {
  let ll = vec2f(0.5);
  return array<vec2f, 4>(
    vec2f(-ll.x, ll.y),
    ll + vec2f(0.0, ll.y),
    -ll,
    vec2f(ll.x, -ll.y) + vec2f(0.0, ll.y),
  );
}

// The extruded image: floor plus blocks.
fn map(p: vec3f) -> f32 {
  let fl = p.y;
  let d4 = blocks(p.xzy); // q.xy is the ground plane, q.z the height.
  g_id = d4;

  obj_id = select(OBJ_BLOCKS, OBJ_FLOOR, fl < d4.x);
  return min(fl, d4.x);
}

// Basic raymarcher.
fn trace(ro: vec3f, rd: vec3f) -> f32 {
  var t = 0.0;
  for (var i = 0; i < 96; i++) {
    let d = map(ro + rd * t);
    // Note the "t*b + a" addition: less emphasis on accuracy as t increases —
    // a cheap trick that works in most situations. Not all, though.
    if (abs(d) < 0.001 * (1.0 + t * 0.1) || t > FAR) {
      break;
    }
    t += select(d * 0.75, d * 0.5, i < 32);
  }
  return min(t, FAR);
}

// Standard normal function — six samples on the axes, more symmetrical than
// the tetrahedral trick (and the original's loop unrolls to exactly this).
fn get_normal(p: vec3f) -> vec3f {
  let e = vec3f(0.001, 0.0, 0.0);
  let x = map(p + vec3f(e.x, 0.0, 0.0)) - map(p - vec3f(e.x, 0.0, 0.0));
  let y = map(p + vec3f(0.0, e.x, 0.0)) - map(p - vec3f(0.0, e.x, 0.0));
  let z = map(p + vec3f(0.0, 0.0, e.x)) - map(p - vec3f(0.0, 0.0, e.x));
  return normalize(vec3f(x, y, z));
}

// Cheap shadows are hard. More iterations make nicer shadows but slow things
// down; 32 is what the original settled on.
fn soft_shadow(ro: vec3f, lp: vec3f, n: vec3f, k: f32) -> f32 {
  let origin = ro + n * 0.0011;
  var rd = lp - origin; // Unnormalized direction ray.

  var shade = 1.0;
  var t = 0.0;
  let end = max(length(rd), 0.0001);
  rd /= end;

  for (var i = 0; i < 32; i++) {
    let d = map(origin + rd * t);
    // The guard on t keeps the first sample (t = 0) from dividing by zero; it
    // cannot darken anything anyway.
    shade = min(shade, k * d / max(t, 1e-6));
    // Ray shortening hack: not entirely accurate, but it reduces shadow
    // artifacts on this particular stubborn distance field.
    t += clamp(d * 0.8, 0.01, 0.25);
    if (d < 0.0 || t > end) {
      break;
    }
  }
  return max(shade, 0.0);
}

// Ambient occlusion, five taps outward along the normal.
fn calc_ao(p: vec3f, n: vec3f) -> f32 {
  var sca = 1.5;
  var occ = 0.0;
  for (var i = 0; i < 5; i++) {
    let hr = f32(i + 1) * 0.15 / 5.0;
    let d = map(p + n * hr);
    occ += (hr - d) * sca;
    sca *= 0.7;
  }
  return clamp(1.0 - occ, 0.0, 1.0);
}

// Compact, self-contained version of IQ's 3D value noise.
fn n3d(p_in: vec3f) -> f32 {
  let s = vec3f(7.0, 157.0, 113.0);
  var p = p_in;
  let ip = floor(p);
  p -= ip;
  var h = vec4f(0.0, s.y, s.z, s.y + s.z) + dot(ip, s);
  p = p * p * (3.0 - 2.0 * p);
  let a = fract(sin(wrap4(h, 6.2831589)) * 43758.5453);
  let b = fract(sin(wrap4(h + s.x, 6.2831589)) * 43758.5453);
  let hx = mix(a, b, p.x);
  // `h.xy = mix(h.xz, h.yw, p.y)` of the original.
  let hy = mix(vec2f(hx.x, hx.z), vec2f(hx.y, hx.w), p.y);
  return mix(hy.x, hy.y, p.z); // Range: [0, 1].
}

// Very basic pseudo environment mapping — it's fake, but it gives the water
// the impression of reflecting the surrounds.
fn env_map(p_in: vec3f) -> vec3f {
  var p = p_in * 3.0;
  let n2 = n3d(p * 2.0);
  // A bit of fBm, with some dark space.
  let c0 = n3d(p) * 0.57 + n2 * 0.28 + n3d(p * 4.0) * 0.15;
  let c = smoothstep(0.4, 1.0, c0);
  p = vec3f(c, c * c, c * c); // Reddish tinge.
  return mix(p, p.xzy, n2 * 0.4); // Mixing in a bit of purple.
}

// Arch window distance field: a square with a semicircle on top.
fn dist_w(p_in: vec2f, sc: f32) -> f32 {
  var p = p_in;
  p.y -= -sc * 1.25 / 3.0;
  let ci = length(p - vec2f(0.0, sc * 1.25)) - sc;
  let sq = s_box(p, vec2f(sc, sc * 1.25));
  return min(ci, sq);
}

// Tri-planar surface texture. The original samples an uploaded `iChannel1`
// once per plane; no asset ships with the background, so the same dominance
// weighting runs over three slices of procedural value noise instead.
fn tri_planar(p: vec3f, n: vec3f) -> vec3f {
  // Effectively max(abs(n), 0.001); the squaring also linearizes the sRGB-ish
  // values before they are blended.
  var nn = max(n * n - 0.2, vec3f(0.001));
  nn /= dot(nn, vec3f(1.0));
  let tx = n3d(vec3f(p.yz, 0.0));
  let ty = n3d(vec3f(p.zx, 0.0));
  let tz = n3d(vec3f(p.xy, 0.0));
  return mat3x3f(vec3f(tx * tx), vec3f(ty * ty), vec3f(tz * tz)) * nn;
}

// -- Entry ------------------------------------------------------------------

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  // GLSL fragment coordinates are bottom-up; WebGPU's are top-down.
  let frag_coord = vec2f(position.x, params.resolution.y - position.y);

  let uv = (frag_coord - params.resolution * 0.5) / params.resolution.y;

  // Camera setup. The ray origin doubles as the camera position, flying down
  // the path.
  var ro = vec3f(0.0, 1.15, params.time);
  var lk = ro + vec3f(0.0, -0.2, 0.25); // "Look at" position.
  var lp = ro + vec3f(-0.185, 0.0, -0.625); // A bit in front of the camera.

  let ro_p = path(ro.z);
  ro = vec3f(ro.x + ro_p.x, ro.y + ro_p.y, ro.z);
  let lk_p = path(lk.z);
  lk = vec3f(lk.x + lk_p.x, lk.y + lk_p.y, lk.z);
  // Artificially moving the light with the camera: point light and distant
  // light qualities at once. Not accurate, but good enough.
  let lp_p = path(lp.z);
  lp = vec3f(lp.x + lp_p.x, lp.y + lp_p.y, lp.z);

  // Ray direction.
  let fov = 1.0;
  let fwd = normalize(lk - ro);
  let rgt = normalize(vec3f(fwd.z, 0.0, -fwd.x));
  let up = cross(fwd, rgt);
  var rd = normalize(uv.x * rgt + uv.y * up + fwd / fov);

  // Swiveling the camera about the travel axis — GLSL's `rd.xy * rot2(..)`,
  // a row-vector product, is transpose(m) * v here.
  let roll = rot2(path(ro.z).x / 32.0);
  rd = vec3f(transpose(roll) * rd.xy, rd.z);

  // Raymarch to the scene.
  let t = trace(ro, rd);

  // Save the winning block's state before the lighting walks overwrite it.
  let sv_g_id = g_id;
  let sv_obj_id = obj_id;
  let sv_p = g_p;
  let sv_v = array<vec2f, 6>(g_v[0].xy, g_v[0].zw, g_v[1].xy, g_v[1].zw, g_v[2].xy, g_v[2].zw);
  let sv_d2d = d2d;

  var col = vec3f(0);

  // The ray hit a surface: light it up.
  if (t < FAR) {
    let sp = ro + rd * t;
    let sn = get_normal(sp);

    var tex_col: vec3f;
    if (sv_obj_id == OBJ_BLOCKS) {
      // Coloring based on extruded hexagonal block height: each pylon has a
      // top face and sides in three height levels — buildings on top, land in
      // the middle, water at the bottom. The top level is the roof color
      // (tCol), the sides the wall color (texCol).
      var t_col: vec3f;
      var hex = sv_d2d;
      hex = max(abs(hex), abs(sp.y - sv_g_id.w * 2.0)) - 0.001;

      // Building colors (the Bavarian, non-`ARID` palette), jittered per
      // block.
      let ra = hash21(sv_g_id.yz + 0.53);
      let rnd2 = vec3f(ra, ra * 0.9, ra * 0.8);
      tex_col = clamp(vec3f(1.0, 0.98, 0.95) * 0.8 + rnd2 * 0.4, vec3f(0.0), vec3f(1.0));
      t_col = clamp(vec3f(1.0, 0.2, 0.2) * 0.8 + rnd2 * 0.4, vec3f(0.0), vec3f(1.0));

      // Grass levels.
      if (sv_g_id.w < 0.4) {
        tex_col = clamp(vec3f(0.8, 0.5, 0.3) * 0.8 + rnd2 * 0.4, vec3f(0.0), vec3f(1.0));
        t_col = clamp(vec3f(0.35, 0.65, 0.3) * 0.8 + rnd2 * 0.4, vec3f(0.0), vec3f(1.0));
      }

      // Water levels.
      if (sv_g_id.w <= WLEV_LEVEL * 0.6 + 0.001) {
        tex_col = clamp(vec3f(0.35, 0.65, 1.0) * 0.9 + rnd2.zyx * 0.2, vec3f(0.0), vec3f(1.0)) *
          vec3f(0.8, 0.9, 1.0);
        t_col = clamp(vec3f(0.25, 0.5, 1.0) * 0.9 + rnd2.zyx * 0.2, vec3f(0.0), vec3f(1.0)) *
          vec3f(0.8, 0.9, 1.0);
      }

      // Extra random colors, just to mix things up.
      let rnd3 = vec3f(
        hash21(sv_g_id.yz + 0.73),
        hash21(sv_g_id.yz + 0.51),
        hash21(sv_g_id.yz),
      ) - 0.5;
      tex_col = clamp(tex_col + rnd3 * 0.1, vec3f(0.0), vec3f(1.0));
      t_col = clamp(t_col - rnd3 * 0.1, vec3f(0.0), vec3f(1.0));

      // Top face vs side color, and a dark rim where the hexagon seam and the
      // roof edge are.
      tex_col = mix(tex_col, t_col, 1.0 - smoothstep(0.0, 0.002, -(sp.y - sv_g_id.w * 2.0)));
      tex_col = mix(tex_col, vec3f(0.0), 1.0 - smoothstep(0.0, 0.002, hex));

      // Painting the windows on the sides of the top-level hexagons: one arch
      // per vertex-edge, skipped for a third of them.
      var win = 1e5;
      if (sv_g_id.w > 0.4) {
        for (var j = 0; j < 6; j++) {
          // Random window ID, stepped per storey so the pattern repeats with
          // the building.
          let w_rnd = hash21(
            sv_g_id.yz + floor((sp.y - sv_g_id.w * 2.0) / WINDOW_PERIOD) + f32(j),
          );
          // Skip the occasional window.
          if (w_rnd < 0.35) {
            continue;
          }

          let g = sv_v[j];
          let g1 = sv_v[(j + 1) % 6];
          // Tangent normal.
          let nj = normalize(g1 - g).yx * vec2f(1.0, -1.0);

          // Position within the storey, then unrotated onto the edge frame.
          let cv = vec2f(
            sv_p.x,
            wrap1(sp.y - sv_g_id.w * 2.0, WINDOW_PERIOD) - WINDOW_PERIOD * 0.5,
          );
          let gg = mix(g, g1, 0.5);
          let ang = atan2(gg.y, gg.x);
          let spos = vec2f(cos(ang), sin(ang)) * length(gg);
          let new_p = rot2(-atan2(nj.x, nj.y)) * (sv_p - spos);

          // Window base and height on this face.
          let w_size = hash21(sv_g_id.yz + 0.71) * 0.075 + 0.2;
          let w_scale = (1.0 / LEVELS) * 0.6 * w_size * 8.0 * GSCALE;
          win = min(win, dist_w(vec2f(max(abs(new_p.x), abs(new_p.y)), cv.y), w_scale));
        }

        // Render the windows.
        win = max(win, sp.y - sv_g_id.w * 2.0);
        tex_col = mix(tex_col, vec3f(0.1, 0.05, 0.03), (1.0 - smoothstep(0.0, 0.003, win - 0.002)) * 0.5);
        tex_col = mix(tex_col, vec3f(0.0), 1.0 - smoothstep(0.0, 0.003, win));
        tex_col = mix(tex_col, vec3f(0.1, 0.05, 0.03), 1.0 - smoothstep(0.0, 0.003, win + 0.005));
      }

      // Adding a bit of texture.
      let tx = smoothstep(vec3f(0.0), vec3f(0.5), tri_planar(sp * 4.0, sn));
      tex_col = tex_col * (tx * 0.6 + 0.6);
    } else {
      // The dark floor behind the pylons: hidden, but you still need it.
      tex_col = vec3f(0.0);
    }

    // Light direction and distance.
    var ld = lp - sp;
    let l_dist = max(length(ld), 0.001);
    ld /= l_dist;

    // Shadows and ambient self shadowing.
    var sh = soft_shadow(sp, lp, sn, 16.0);
    let ao = calc_ao(sp, sn);
    sh = min(sh + ao * 0.0, 1.0);

    // Light attenuation, diffuse, and a Fresnel glow.
    let atten = 1.0 / (1.0 + l_dist * 0.05);
    let diff = max(dot(sn, ld), 0.0);
    let fre = pow(clamp(1.0 - abs(dot(sn, rd)) * 0.5, 0.0, 1.0), 2.0);

    // The original also computes a Schlick-weighted specular; it never reaches
    // its final color, so it is not ported.
    col = tex_col * (diff * sh + ao * 0.15 + 0.05 + vec3f(1.0, 0.9, 0.7) * fre * 0.1);

    // Cheap environment mapping for the water.
    if (sv_g_id.w <= WLEV_LEVEL * 0.6 + 0.001) {
      let c_tex = env_map(reflect(rd, sn));
      col *= 0.85 + c_tex * 1.5;
    }

    col *= ao * atten;
  }

  // Applying some fog on the horizon — the sky *is* the fog color at t = FAR.
  let fog = mix(vec3f(1.0, 0.9, 0.5), vec3f(0.5, 0.7, 1.0), rd.y * 0.5 + 0.5);
  col = mix(col, fog, smoothstep(0.0, 0.99, t / FAR));

  // Rough gamma correction.
  return vec4f(sqrt(max(col, vec3f(0.0))), 1.0);
}
