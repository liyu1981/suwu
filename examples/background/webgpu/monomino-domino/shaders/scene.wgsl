// Scene pass of the Monomino Domino port: extruded cell-by-cell traversal.
//
// Ported to WGSL/vgpu from "Monomino Domino Tile Traversal" by Shane,
// https://www.shadertoy.com/view/l3sBzM (Shadertoy).
//
// Adaptation notes:
//   * The tiling lives in the original's Buffer A back-buffer (tiling.wgsl
//     here); the image pass reads it with textureLoad() instead of
//     texelFetch(iChannel0), wrapping cell IDs with the shared wrap2().
//   * `iChannel1`, the uploaded grunge texture feeding the surface roughness,
//     ships as an asset on Shadertoy. Nothing is shipped here: the same
//     tri-planar weighting runs over procedural value noise instead. Its
//     other use (a per-block texture lookup) feeds a line the original has
//     commented out, so it is dropped.
//   * The commented-out edge routine is why the original saves the box
//     dimensions and local coordinates; both are dead code and not ported.
//   * Fragment Y is flipped: WebGPU's origin is top-left, GLSL's is bottom-left.
//   * The march renders into an offscreen target capped by the host (the
//     `detail` setting) and is blitted to the canvas, so the 128-step
//     traversal never over-spends pixels on a high-DPR display.
//   * The host scales `time` by the user's animation-speed setting; the
//     camera flight and the animated tile heights read it, and the back-buffer
//     assembly pace (a CPU-side `gate`) is derived from it too.

import {
  GRID_SIZE,
  brdf,
  e_dirs,
  hash21,
  hash31,
  hash42,
  rot2,
  wrap1,
  wrap2,
  wrap4,
} from "./common.wgsl";

// -- Bindings ---------------------------------------------------------------

struct Params {
  resolution: vec2f,
  time: f32,
  _pad: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
// The settled tiling: .x = link direction (0 = monomino), .y = cell ID.
@group(0) @binding(1) var buf_in: texture_2d<f32>;

// -- Constants ---------------------------------------------------------------

// Max ray distance.
const FAR: f32 = 20.0;
// Cell (grid step) size in world units — the original's `sc`.
const CELL: f32 = 0.25;
// Scene object IDs.
const OBJ_BLOCKS: f32 = 0.0;
const OBJ_FLOOR: f32 = 1.0;
// Corner roundness pool; only the first two values are ever picked.
const CORNER_SIZES = vec4f(0.15, 0.5, 0.25, 0.0);
// Luminance weights.
const LUMA = vec3f(0.299, 0.587, 0.114);

// -- Globals ----------------------------------------------------------------
//
// The original keeps these in GLSL globals between map() and mainImage: the
// winning cell has to survive the trace, while the traversal step distance
// (g_cd) is recomputed by every map() call against the current ray (set by
// trace() or softShadow() before they march).

var<private> g_dir: vec3f;
var<private> g_rd: vec3f;
var<private> g_cd: f32;
var<private> g_id: vec4f;
var<private> obj_id: f32;

// -- Cell state -------------------------------------------------------------

// The wrapped cell state — the original's tx().
fn tx(coord: vec2f) -> vec4f {
  return textureLoad(buf_in, vec2i(wrap2(coord, GRID_SIZE)), 0);
}

// IQ's rounded box with variable roundness per corner: `r` runs clockwise from
// the bottom left — vec4(bLft, tLft, tRgt, bRgt).
// https://www.shadertoy.com/view/4llXD7
fn s_box_s(p_in: vec2f, b: vec2f, r: vec4f) -> f32 {
  // Pick this quadrant's radius (swizzle-free port of the original's
  // `r.xy = p.x<0. ? r.yx : r.wz; r.x = p.y<0. ? r.y : r.x;`, which reads the
  // values updated by its own first line).
  let rx1 = select(r.w, r.y, p_in.x < 0.0);
  let ry1 = select(r.z, r.x, p_in.x < 0.0);
  let rad = select(ry1, rx1, p_in.y < 0.0);

  let p = abs(p_in) - b + rad;
  return min(max(p.x, p.y), 0.0) + length(max(p, vec2f(0.0))) - rad;
}

// IQ's extrusion formula, with the original's rounding term.
fn op_extrusion(sdf: f32, pz: f32, h: f32, sf: f32) -> f32 {
  let w = vec2f(sdf, abs(pz) - h) + sf;
  return min(max(w.x, w.y), 0.0) + length(max(w, vec2f(0.0))) - sf;
}

// Subdivided rectangle grid: the 2D shape of the cell under q, plus the
// position-based ID of the (possibly joined) block it belongs to. The local
// coordinates p are computed by the caller — the original takes them inout
// only to feed two globals that its commented-out edge routine used.
fn grid_cell(p: vec2f, ip: vec2f, buf_a: vec4f, sc: vec2f) -> vec3f {
  var obj = 1e5; // Cell object.
  let lw = sc / 2.0; // Rectangle half dimensions.

  // Converting the packed single-value buffer position to 2D coordinates:
  // the stored ID is wrapped to the 32² grid, so lift it back into the
  // absolute cell block the ray is currently traversing.
  var p_id = vec2f(wrap1(buf_a.y, GRID_SIZE), floor(buf_a.y / GRID_SIZE));
  p_id += floor(ip / GRID_SIZE) * GRID_SIZE;

  // Cast to one of five possible integer values: zero for no links, the other
  // four for a link direction (left, up, right, down).
  let i_val = i32(buf_a.x);

  if (i_val == 0) {
    // No links to adjoining cells: a single monomino square with random
    // corner roundness.
    let v_rnd = hash42(p_id);
    let rnd_index = vec4i(wrap4(floor(v_rnd * 72.0), 2.0));
    let r = vec4f(
      CORNER_SIZES[rnd_index.x],
      CORNER_SIZES[rnd_index.y],
      CORNER_SIZES[rnd_index.z],
      CORNER_SIZES[rnd_index.w],
    );
    obj = s_box_s(p, lw, r * sc.x);
  } else {
    // A cell with an adjoining link: render the 1×2 domino centred on the
    // shared edge. Both halves of the pair arrive at the same joined ID, so
    // they hash the same corner values and agree on the shape.
    let i = i_val - 1;
    let e = e_dirs();
    p_id += e[i] * 0.5;

    // Move to the cell edge, swapping axes for the vertical links so one box
    // distance serves both orientations.
    let d = p - e[i] * sc / 2.0;
    let q = select(vec2f(d.y, -d.x), d, (i & 1) == 0);

    let v_rnd = hash42(p_id);
    let rnd_index = vec4i(wrap4(floor(v_rnd * 72.0), 2.0));
    let r = vec4f(
      CORNER_SIZES[rnd_index.x],
      CORNER_SIZES[rnd_index.y],
      CORNER_SIZES[rnd_index.z],
      CORNER_SIZES[rnd_index.w],
    );
    obj = min(obj, s_box_s(q, lw + vec2f(lw.x, 0.0), r * sc.x));
  }

  // Decreasing the size just a little.
  obj += 0.005;
  return vec3f(obj, p_id * sc);
}

// -- Height -----------------------------------------------------------------

// The animated tile height at a block's position. The original's commented
// texture reads are gone; this is a time-driven ripple, so the relief of the
// whole field breathes as the camera flies over it.
fn hm(p: vec2f, time: f32) -> f32 {
  let h = dot(sin(p - cos(p.yx * 2.5 + time * 2.0)), vec2f(0.25)) + 0.5;
  return smoothstep(0.2, 1.0, h) * 0.7 + h * 0.3;
}

// -- Scene ------------------------------------------------------------------

// The extruded cell grid: one cell's cached shape, the traversal step to the
// cell wall, then the extrusion at the cell's animated height.
fn blocks(q: vec3f) -> vec4f {
  let sc = vec2f(CELL, CELL);

  // Positional cell ID and local coordinates.
  let ip = floor(q.xy / sc);
  let p = q.xy - (ip + 0.5) * sc;

  let cell = grid_cell(p, ip, tx(ip), sc);
  var d2 = cell.x;
  let id = cell.yz;

  // Cell-by-cell traversal: distance to the wall of the current cell in the
  // ray's direction — not the minimum wall distance, so the march traces out
  // instead of merely doing a box calculation. It restricts the ray from
  // overshooting, which in turn restricts artifacts.
  let r_c = (g_dir.xy * sc - p) / g_rd.xy;
  // Never negative (no tracing backwards), plus a touch to advance onward.
  g_cd = max(min(r_c.x, r_c.y), 0.0) + 0.001;

  // The extruded block height.
  var h = hm(id, params.time);
  h = h + 0.05;

  // Thin holes.
  d2 = max(d2, -(d2 + sc.x * 0.55));

  // Extrude the 2D shape.
  var d = op_extrusion(d2, q.z + h / 2.0, h / 2.0, 0.0);
  // Beveling.
  d -= min(-d2 / sc.x, 0.15) * 0.25;

  return vec4f(d, d2, id);
}

// The extruded image: floor plus blocks.
fn map(p: vec3f) -> f32 {
  let fl = -p.z;
  let d4 = blocks(p);
  g_id = d4;

  obj_id = select(OBJ_BLOCKS, OBJ_FLOOR, fl < d4.x);
  return min(fl, d4.x);
}

// Basic raymarcher. The cell step distance clamps every advance, so the ray
// moves cell by cell instead of overshooting walls.
fn trace(ro: vec3f, rd: vec3f) -> f32 {
  // Ray direction signs, used by map() to pick the wall it is tracing toward.
  g_dir = select(vec3f(-0.5), vec3f(0.5), rd >= vec3f(0.0));
  g_rd = rd;

  var t = 0.0;
  for (var i = 0; i < 128; i++) {
    let d = map(ro + rd * t);
    if (abs(d) < 0.001 || t > FAR) {
      break;
    }
    t += min(d, g_cd);
  }
  return min(t, FAR);
}

// Standard normal function — six samples on the axes.
fn get_normal(p: vec3f) -> vec3f {
  let e = vec3f(0.001, 0.0, 0.0);
  let x = map(p + vec3f(e.x, 0.0, 0.0)) - map(p - vec3f(e.x, 0.0, 0.0));
  let y = map(p + vec3f(0.0, e.x, 0.0)) - map(p - vec3f(0.0, e.x, 0.0));
  let z = map(p + vec3f(0.0, 0.0, e.x)) - map(p - vec3f(0.0, 0.0, e.x));
  return normalize(vec3f(x, y, z));
}

// Cheap shadows are hard. 48 iterations make a decent one; the cell step
// distance keeps them from skipping through walls.
fn soft_shadow(ro: vec3f, lp: vec3f, n: vec3f, k: f32) -> f32 {
  let origin = ro + n * 0.0015;
  var rd = lp - origin; // Unnormalized direction ray.

  var shade = 1.0;
  var t = 0.0;
  let end = max(length(rd), 0.0001);
  rd /= end;

  g_dir = select(vec3f(-0.5), vec3f(0.5), rd >= vec3f(0.0));
  g_rd = rd;

  for (var i = 0; i < 48; i++) {
    let d = map(origin + rd * t);
    // The guard on t keeps the first sample (t = 0) from dividing by zero; it
    // cannot darken anything anyway.
    shade = min(shade, k * d / max(t, 1e-6));
    t += clamp(min(d, g_cd), 0.02, 0.25);
    if (d < 0.0 || t > end) {
      break;
    }
  }
  return max(shade, 0.0);
}

// Ambient occlusion, five taps outward along the normal.
fn calc_ao(p: vec3f, n: vec3f) -> f32 {
  var sca = 2.0;
  var occ = 0.0;
  for (var i = 0; i < 5; i++) {
    let hr = f32(i + 1) * 0.125 / 5.0;
    let d = map(p + n * hr);
    occ += (hr - d) * sca;
    sca *= 0.7;
  }
  return clamp(1.0 - occ, 0.0, 1.0);
}

// -- Grunge -----------------------------------------------------------------

// Compact, self-contained 3D value noise (built on the integer hash).
fn n3d(p_in: vec3f) -> f32 {
  let i = floor(p_in);
  var f = p_in - i;
  f = f * f * (3.0 - 2.0 * f);
  let a = mix(
    mix(hash31(i + vec3f(0.0, 0.0, 0.0)), hash31(i + vec3f(1.0, 0.0, 0.0)), f.x),
    mix(hash31(i + vec3f(0.0, 1.0, 0.0)), hash31(i + vec3f(1.0, 1.0, 0.0)), f.x),
    f.y,
  );
  let b = mix(
    mix(hash31(i + vec3f(0.0, 0.0, 1.0)), hash31(i + vec3f(1.0, 0.0, 1.0)), f.x),
    mix(hash31(i + vec3f(0.0, 1.0, 1.0)), hash31(i + vec3f(1.0, 1.0, 1.0)), f.x),
    f.y,
  );
  return mix(a, b, f.z); // Range: [0, 1].
}

// Tri-planar surface grunge, replacing the uploaded `iChannel1` with the same
// planar weighting over procedural noise (the original's tex3D).
fn tri_planar(p: vec3f, n: vec3f) -> vec3f {
  // Effectively max(abs(n), 0.001); the squaring linearizes the sRGB-ish
  // values before they are blended.
  var nn = max(n * n - 0.2, vec3f(0.001));
  nn /= dot(nn, vec3f(1.0));
  let tx_ = n3d(vec3f(p.z, p.y, 0.0));
  let ty = n3d(vec3f(p.x, p.z, 0.0));
  let tz = n3d(vec3f(p.x, p.y, 0.0));
  return mat3x3f(vec3f(tx_ * tx_), vec3f(ty * ty), vec3f(tz * tz)) * nn;
}

// -- Entry ------------------------------------------------------------------

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  // GLSL fragment coordinates are bottom-up; WebGPU's are top-down.
  let frag_coord = vec2f(position.x, params.resolution.y - position.y);
  let uv = (frag_coord - params.resolution * 0.5) / params.resolution.y;

  // Camera setup: flying over the field along +x.
  let ro = vec3f(params.time / 2.0, 0.0, -3.0);
  let lk = ro + vec3f(0.0, 0.05, 0.25); // "Look at" position.
  let lp = ro + vec3f(2.0, 1.0, 0.0); // Light near the camera.

  let fov = 1.25;
  let fwd = normalize(lk - ro);
  let rgt = normalize(vec3f(fwd.z, 0.0, -fwd.x));
  let up = cross(fwd, rgt);
  var rd = normalize(uv.x * rgt + uv.y * up + fwd / fov);

  // Fixed camera tilt — GLSL's `rd.xy * rot2(-.25)`, a row-vector product,
  // is transpose(m) * v here.
  let roll = rot2(-0.25);
  rd = vec3f(transpose(roll) * rd.xy, rd.z);

  // Raymarch to the scene.
  let t = trace(ro, rd);

  // Save the winning cell before the lighting walks overwrite the globals.
  let sv_g_id = g_id;
  let sv_obj_id = obj_id;

  var col = vec3f(0);

  // The ray hit a surface: light it up.
  if (t < FAR) {
    let sp = ro + rd * t;
    let sn = get_normal(sp);

    let ld0 = lp - sp;
    let l_dist = max(length(ld0), 0.001);
    let ld = ld0 / l_dist;

    // Standard material properties: roughness, matType and reflectance.
    var roughness = 1.0;
    let mat_type = 0.0; // Dielectric (non conducting).
    let reflectance = 0.25;

    var o_col: vec3f;
    if (sv_obj_id == OBJ_BLOCKS) {
      // Random coloring using IQ's short versatile palette formula, with a
      // third of the blocks knocked back to gray.
      let rnd = hash21(sv_g_id.zw + 0.34);
      var s_col = 0.5 + 0.45 * cos(6.2831853 * rnd + vec3f(0.0, 1.0, 2.0) * 1.5);
      let gr = vec3f(dot(s_col, LUMA));
      if (hash21(sv_g_id.zw + 0.24) < 0.33) {
        s_col = gr;
      }
      o_col = s_col;

      // Grunge texturing feeds the roughness: brighter grunge, glossier tile.
      let tx2 = tri_planar(sp, sn);
      let gr_t = dot(tx2, LUMA);
      roughness *= gr_t * gr_t * 4.0;
    } else {
      // The dark floor in the background. Hidden behind the pylons, but the
      // original includes it anyway.
      o_col = vec3f(0.0);
    }

    // Shadows and ambient self shadowing.
    var sh = soft_shadow(sp, lp, sn, 16.0);
    let ao = calc_ao(sp, sn);

    // Light attenuation, based on the distance from the light.
    let atten = 1.0 / (1.0 + l_dist * 0.05);

    // A little more than a constant for ambient light — Blackle's "Quick
    // Lighting Tech" (https://www.shadertoy.com/view/ttGfz1), outdoor variant.
    let am = length(sin(sn * 2.0) * 0.5 + 0.5) / sqrt(3.0) * smoothstep(-1.0, 1.0, -sn.z);

    // Cook-Torrance based lighting. The last term is specular coloring.
    let ct = brdf(o_col, sn, ld, -rd, mat_type, roughness, reflectance, vec3f(1.0));

    // Combining the ambient and microfaceted terms, with the original's
    // hacky ambient shadow term, then AO and attenuation.
    col = o_col * am * (0.75 + sh * 0.25) + ct * sh;
    col *= ao * atten;
  }

  // No fog: the original's fog line is commented out.
  // Rough gamma correction.
  return vec4f(sqrt(max(col, vec3f(0.0))), 1.0);
}
