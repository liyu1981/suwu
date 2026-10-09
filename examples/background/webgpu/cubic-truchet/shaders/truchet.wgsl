// Cubic Truchet Pattern — a raymarched lattice of decorated toroidal tiles.
//
// Ported to WGSL/vgpu from "Cubic Truchet Pattern" by Shane,
// https://www.shadertoy.com/view/4lfcRl (Shadertoy).
//
// Adaptation notes:
//   * Single-pass by design: the original has no buffer tab, so this is a
//     declarative fragmentScene() — one march pass into a capped target, one
//     blit to the canvas.
//   * The original's `nrm()` takes `inout` edge/curvature parameters; WGSL
//     has no `inout`, so it returns vec4(normal, edge). The curvature tap set
//     was already commented out upstream (and its output unused), so it is
//     not ported.
//   * Fragment Y is flipped: WebGPU's origin is top-left, GLSL's is bottom-left.
//   * The host scales `time` by the user's animation-speed setting; the camera
//     flight, the view sway, the colour drift and the blinking lights all
//     read it.

// Maximum ray distance.
const FAR: f32 = 80.0;

// The scene runs on one uniform: aspect-corrected resolution plus the scaled
// clock. `resolution.y` also feeds the edge-line width in nrm().
struct Params {
  resolution: vec2f,
  time: f32,
  _pad: f32,
}

@group(0) @binding(0) var<uniform> params: Params;

// Scene object IDs: main tube, colored band, or colored inner tube.
// vObjID holds the three candidate distances for the sort that happens
// outside the marching loop; gID the angular segment ID of the nearest tube,
// which drives the blinking lights. The original stores both as globals set
// inside the distance function — not fond of it, but necessary here.
var<private> v_obj_id: vec3f;
var<private> g_id: f32;

// Standard 2D rotation formula.
fn rot2(a: f32) -> mat2x2f {
  let c = cos(a);
  let s = sin(a);
  return mat2x2f(vec2f(c, -s), vec2f(s, c));
}

// GLSL's mod(): the floor-based, always-positive remainder (ia can go
// negative on the far side of the circle).
fn wrap1(x: f32, y: f32) -> f32 {
  return x - y * floor(x / y);
}

// Squarish tube with beveled sides. Callers pass `p` in its absolutized form.
// .7071 for an octagon, etc.
fn tube(p: vec2f) -> f32 {
  return max(max(p.x, p.y), (p.x + p.y) * 0.5773);
}

// The toroidal tube objects: a white squarish outer tube, a similar colored
// inner one (only visible through the holes), and some colored bands. Returns
// (outer, band, inner, angular segment ID).
fn tor_tube(p_in: vec3f) -> vec4f {
  var p = p_in;

  // Tube width.
  const rad2: f32 = 0.065;

  // Main tube: convert one coordinate to its circular form and it's a torus
  // rather than a straight tube.
  var tb = tube(abs(vec2f(length(p.xy) - 0.5, p.z))) - rad2;

  // Inner tube for colored lights.
  let inner_tb = tb + 0.015;

  // Tube segments - for the bands and holes: break the circle into 8 lots
  // of 3 cells.
  const a_num: f32 = 24.0;

  // Subtended angle, partitioned into cells, then the angle at the center.
  let a = atan2(p.y, p.x);
  let ia = floor(a / 6.283 * a_num) + 0.5; // .5 to move to the cell center.

  // Polar coordinates: radial position in p.x, angular in p.y — then advance
  // the decorations out to the torus radius (.5).
  let rotated = rot2(ia * 6.283 / a_num) * p.xy;
  p = vec3f(rotated.x, rotated.y, p.z);
  p.x -= 0.5;
  p = abs(p);

  var band = 1e5;

  // Group the 24 cells into groups of 3: cover every third with a colored
  // band, bore holes in the others.
  if (wrap1(ia + 1.0, 3.0) > 2.0) {
    band = max(tube(p.xz) - rad2 - 0.01, p.y - 0.04);
    band = max(band, min(band + 0.005, -p.y + 0.015));
  } else {
    // Break the cell into four, to bore four holes in each. Comment it out
    // to produce just one hole.
    p = abs(p - 0.02);
    // Cut out two cross sections from the main tube.
    tb = max(tb, -min(tube(p.xy) - rad2 + 0.055, tube(p.yz) - rad2 + 0.055));
  }

  return vec4f(tb, band, inner_tb, ia);
}

// The Truchet pre-test: you only need the *closest* of the three tubes, not
// the closest decorated one — so compare squared distances first, and return
// the unique oriented point that corresponds to the nearest.
fn tor_tube_test(p: vec3f) -> vec4f {
  let v = vec2f(length(p.xy) - 0.5, p.z);
  return vec4f(p, dot(v, v));
}

// The extruded pattern: unit cubes, each randomly rotated by a swizzle so
// another face points forward, three torii per tile.
fn map(p_in: vec3f) -> f32 {
  var p = p_in;

  // Random ID for each grid cube.
  let rnd = fract(sin(dot(floor(p + vec3f(111.0, 73.0, 27.0)), vec3f(7.63, 157.31, 113.97))) * 43758.5453);

  // Partition space into a grid of unit cubes.
  p = fract(p) - 0.5;

  // Use each cube's random ID to rotate it in such a way that another one of
  // its faces is facing forward.
  if (rnd > 0.833) {
    p = p.xzy;
  } else if (rnd > 0.666) {
    p = p.yxz;
  } else if (rnd > 0.5) {
    p = p.yzx;
  } else if (rnd > 0.333) {
    p = p.zxy;
  } else if (rnd > 0.166) {
    p = p.zyx;
  }

  // Each tile contains three decorated tubes, but only the closest *plain*
  // tube can win — squared distances compare fine.
  let tb1 = tor_tube_test(vec3f(p.xy + 0.5, p.z));
  let tb2 = tor_tube_test(vec3f(p.yz - 0.5, p.x));
  let tb3 = tor_tube_test(vec3f(p.xz - vec2f(0.5, -0.5), p.y));

  // Sort the distances, then keep the closest oriented point.
  p = select(
    select(tb3.xyz, tb2.xyz, tb2.w < tb3.w),
    tb1.xyz,
    tb1.w < tb2.w && tb1.w < tb3.w,
  );

  // Render the randomly aligned block: three quarter torii plus the bells and
  // whistles. Nine candidate objects in all, reduced to three minima.
  let tb = tor_tube(p);

  // A unique angular segment identifier - used to produce the blinking lights.
  g_id = tb.w;

  // The per-category minima, kept for the object sort outside the loop.
  v_obj_id = tb.xyz;
  return min(min(v_obj_id.x, v_obj_id.y), v_obj_id.z);
}

// Recreates part of the distance function to obtain the segment ID for the
// blink effect: reuse the cell's random number, then blink at random.
fn light_blink(p: vec3f, gid: f32) -> f32 {
  var rnd = fract(sin(dot(floor(p + vec3f(111.0, 73.0, 27.0)), vec3f(7.63, 157.31, 113.97))) * 43758.5453);
  rnd = fract(rnd + gid * 43758.54571);
  return smoothstep(0.33, 0.66, sin(rnd * 6.283 + params.time * 3.0) * 0.5 + 0.5);
}

// Standard raymarching algorithm.
fn trace(o: vec3f, r: vec3f) -> f32 {
  var t = 0.0;
  for (var i = 0; i < 128; i++) {
    let d = map(o + r * t);
    // Within the surface threshold, or past the maximum: exit.
    if (abs(d) < 0.001 * (t * 0.125 + 1.0) || t > FAR) {
      break;
    }
    t += d;
  }
  return min(t, FAR);
}

// Cheap shadows. `t` seeds the step distance to coincide with the hit
// condition in trace().
fn shadow(ro: vec3f, lp: vec3f, k: f32, t: f32) -> f32 {
  var rd = lp - ro; // Unnormalized direction ray.

  var shade = 1.0;
  var dist = 0.001 * (t * 0.125 + 1.0);
  let end = max(length(rd), 0.0001);
  rd /= end;

  for (var i = 0; i < 32; i++) {
    let h = map(ro + rd * dist);
    // Subtle difference over the plain ratio — thanks to IQ for this tidbit.
    shade = min(shade, smoothstep(0.0, 1.0, k * h / dist));
    dist += clamp(h, 0.01, 0.2);
    if (h < 0.0 || dist > end) {
      break;
    }
  }
  return min(max(shade, 0.0), 1.0);
}

// IQ-style ambient occlusion, five taps.
fn calc_ao(pos: vec3f, nor: vec3f) -> f32 {
  var sca = 1.0;
  var occ = 0.0;
  for (var i = 0; i < 5; i++) {
    let hr = 0.01 + f32(i) * 0.35 / 4.0;
    let dd = map(nor * hr + pos);
    occ += (hr - dd) * sca;
    sca *= 0.7;
  }
  return clamp(1.0 - occ, 0.0, 1.0);
}

// Normal calculation, with the edging bundled in. Returns vec4(normal, edge):
// WGSL has no `inout`, and the original's curvature output went unused.
// The edge epsilon mixes a fixed and a resolution-dependent value — the lines
// get thicker at larger resolutions, but not too thick.
fn nrm(p: vec3f, t: f32) -> vec4f {
  var e = vec2f(1.0 / mix(400.0, params.resolution.y, 0.5) * (1.0 + t * 0.5), 0.0);

  let d1 = map(p + e.xyy);
  let d2 = map(p - e.xyy);
  let d3 = map(p + e.yxy);
  let d4 = map(p - e.yxy);
  let d5 = map(p + e.yyx);
  let d6 = map(p - e.yyx);
  let d = map(p) * 2.0;

  var edge = abs(d1 + d2 - d) + abs(d3 + d4 - d) + abs(d5 + d6 - d);
  edge = smoothstep(0.0, 1.0, sqrt(edge / e.x * 2.0));

  e = vec2f(0.002, 0.0);
  let e1 = map(p + e.xyy);
  let e2 = map(p - e.xyy);
  let e3 = map(p + e.yxy);
  let e4 = map(p - e.yxy);
  let e5 = map(p + e.yyx);
  let e6 = map(p - e.yyx);

  return vec4f(normalize(vec3f(e1 - e2, e3 - e4, e5 - e6)), edge);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  // GLSL fragment coordinates are bottom-up; WebGPU's are top-down.
  let frag_coord = vec2f(position.x, params.resolution.y - position.y);

  // Aspect correct screen coordinates.
  let uv = (frag_coord - params.resolution * 0.5) / params.resolution.y;

  // Ray origin, or camera - moving along the Z-axis.
  let o = vec3f(0.0, 0.0, params.time);
  // Light, situated near the camera and moving along with it.
  let lp = vec3f(-1.0, 3.0, -0.25) + o;

  // Unit ray vector.
  var r = normalize(vec3f(uv, 1.0));

  // Rotating "r" back and forth along various axes for some cheap camera
  // movement — GLSL's `r.xz *= rot2(..)` scatters a row-vector product back
  // into two components.
  let sway_xz = rot2(sin(params.time / 2.0) * 0.4);
  let rxz = transpose(sway_xz) * vec2f(r.x, r.z);
  r = vec3f(rxz.x, r.y, rxz.y);
  let sway_xy = rot2(cos(params.time / 2.0) * 0.2);
  let rxy = transpose(sway_xy) * vec2f(r.x, r.y);
  r = vec3f(rxy.x, rxy.y, r.z);

  // Trace out the scene.
  let t = trace(o, r);

  // Determining the object ID: sorting the three candidates outside the loop
  // is less readable, but faster.
  let obj_id = select(
    select(2.0, 1.0, v_obj_id.y < v_obj_id.z),
    0.0,
    v_obj_id.x < v_obj_id.y && v_obj_id.x < v_obj_id.z,
  );

  // Segment ID, fed into the blinking light effect.
  let sv_gid = g_id;

  // Initiate the scene color to zero.
  var sc = vec3f(0.0);

  // An object in the scene has been hit, so light it.
  if (t < FAR) {
    // Hit position.
    let sp = o + r * t;

    // Normal, plus edge darkening.
    let ne = nrm(sp, t);
    let sn = ne.xyz;
    let edge = ne.w;

    // A gradient color based on position, drifting with time.
    var o_col = mix(
      vec3f(1.0, 0.1, 0.3),
      vec3f(1.0, 0.5, 0.1),
      dot(sin(sp * 8.0 - cos(sp.yzx * 4.0)), vec3f(0.166)) + 0.5,
    );
    o_col = mix(
      o_col,
      o_col.yzx,
      smoothstep(0.3, 1.0, dot(sin(sp * 4.0 + cos(sp.zxy * 4.0 + params.time)), vec3f(0.166 * 0.6)) + 0.3),
    );

    // Color the individual objects based on their category.
    if (obj_id < 0.5) {
      o_col = mix(o_col, vec3f(1.0), 0.97); // The whitish tube.
    } else if (obj_id < 1.5) {
      o_col = mix(o_col, vec3f(1.0), 0.05); // The colorful bands.
    } else {
      // Inner tube color, plus the blinking light effect: the segment ID
      // makes each light blink at its own random interval.
      o_col = mix(o_col, vec3f(1.0), 0.05);
      o_col *= light_blink(sp, sv_gid) * 7.5 + 0.5;
    }

    // Ambient occlusion and shadows.
    let ao = calc_ao(sp, sn);
    let sh = shadow(sp + sn * 0.002, lp, 16.0, t);

    // Point light direction, distance and attenuation.
    let ld0 = lp - sp;
    let dist = max(length(ld0), 0.001);
    let ld = ld0 / dist;
    let atten = 3.5 / (1.0 + dist * 0.05 + dist * dist * 0.05);

    // Diffuse light.
    let diff = max(dot(ld, sn), 0.0);

    // Combining the terms, then the dark edges, attenuation, shadows and AO.
    sc = o_col * (diff + ao * 0.35);
    sc *= (1.0 - edge * 0.7) * atten * (sh + ao * 0.3) * ao;
  }

  // Basic camera distance fog, fading to black — not to be confused with the
  // light-to-surface attenuation.
  let fog = 1.0 / (1.0 + t * 0.125 + t * t * 0.05);
  sc = mix(vec3f(0.0), sc, fog);

  // Subtle vignette with a colored variation: the edges run through a
  // channel-wise gamma crush (the original's `vec3(1.5,1,1).zyx` and
  // `vec3(1,3,16).zyx`), then blend back by a corner falloff.
  let screen = frag_coord / params.resolution;
  let crush = pow(
    min(vec3f(1.0, 1.0, 1.5) * sc, vec3f(1.0)),
    vec3f(16.0, 3.0, 1.0),
  );
  let corner = pow(
    16.0 * screen.x * screen.y * (1.0 - screen.x) * (1.0 - screen.y),
    0.125,
  );
  sc = mix(crush, sc, corner * 0.75 + 0.25);

  // Rough gamma correction.
  return vec4f(sqrt(max(sc, vec3f(0.0))), 1.0);
}
