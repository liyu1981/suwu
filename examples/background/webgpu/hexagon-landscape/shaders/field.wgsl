// Buffer pass of the Hexagon Landscape port: the offset-hexagon distance field.
//
// The Shadertoy original precalculates this expensive field once into a cube-map
// buffer face (mainCubemap in its "Buffer A" tab) and reads it back every
// frame: "Without this, the example would fry your GPU." Here the same work is
// a single 1024² fragment pass over one tile of world space, encoded on the
// background's first frame — the host never re-runs it.
//
// The tile wraps seamlessly: hash42B wraps every four cells (one world unit)
// and the cell grid divides that exactly, so texel (x + 1024) holds what
// texel x does — the scene pass wraps its lookup with fract().

import { FIELD_SIZE, GSCALE, NDG, offset_verts, sd_poly } from "./common.wgsl";

// The four hexagon cell centers of one repeat cell, flat-top arrangement (the
// original's `ps4`): length to height ratio comes out of the corner positions.
fn cell_centers() -> array<vec2f, 4> {
  let ll = vec2f(0.5);
  return array<vec2f, 4>(
    vec2f(-ll.x, ll.y),
    ll + vec2f(0.0, ll.y),
    -ll,
    vec2f(ll.x, -ll.y) + vec2f(0.0, ll.y),
  );
}

// Distances of the four offset hexagons covering world point q, packed in the
// original's vect8.distA order. The hexagons are rounded by nudging every
// vertex inward along its angle bisector first — in a packed grid, adding a
// radius to the distance alone would make neighbours overlap.
fn df(q: vec2f) -> vec4f {
  let dim = vec2f(GSCALE, GSCALE);
  // Repeat cell size.
  let s = dim * 2.0;
  let centers = cell_centers();

  var out: vec4f;
  for (var i = 0; i < 4; i++) {
    let cntr = centers[i] / 2.0;

    var p = q;
    let ip = floor(p / s - cntr) + 0.5; // Local tile ID.
    p -= (ip + cntr) * s; // New local position.
    let idi = ip + cntr; // Correct positional tile ID.

    // Offset, scaled hexagon vertices (shared with the scene pass).
    let vert = offset_verts(idi);
    var v1 = array<vec2f, 6>(
      vert[0].xy,
      vert[0].zw,
      vert[1].xy,
      vert[1].zw,
      vert[2].xy,
      vert[2].zw,
    );

    // Move the vertices in to create rounded hexagons: each vertex travels
    // along its tangent by nudge/tan(half-angle) plus one nudge perpendicular
    // to it. This is a one-off precalculation, so the trig is free.
    var rounded = array<vec2f, 6>(vec2f(0), vec2f(0), vec2f(0), vec2f(0), vec2f(0), vec2f(0));
    for (var j = 0; j < 6; j++) {
      let g = v1[j];
      let g1 = v1[(j + 1) % 6];
      let g2 = v1[(j + 5) % 6];
      let nj = normalize(g1 - g); // Tangent vector.
      let d1 = g - g1;
      let d2 = g - g2;
      // Angle between the flanking edges; clamped because acos() is undefined
      // just outside [-1, 1] and float error can poke it there.
      let ang = acos(clamp(dot(d1, d2) / (length(d1) * length(d2)), -1.0, 1.0));
      let sl = NDG / tan(ang * 0.5);
      rounded[j] = g + sl * nj + NDG * vec2f(nj.y, -nj.x);
    }

    // The slight inward travel is also subtracted from the distance, so the
    // packed faces keep a visible seam between them.
    out[i] = sd_poly(p, rounded) - NDG * 0.9;
  }
  return out;
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return df((position.xy + 0.5) / FIELD_SIZE);
}
