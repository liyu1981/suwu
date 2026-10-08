// Buffer pass of the Hexagon Landscape port: the height map.
//
// The original stores `hm(uv)` on another cube-map face and reads it back in
// hmBlock() — heights are per-tile, so one texture lookup replaces a gradient
// noise evaluation per candidate block per raymarch step. This pass fills the
// same tile once, on the background's first frame; hm() wraps with period 1
// (see hash22C in common.wgsl), so the texture tiles seamlessly and the scene
// pass can sample it with fract(world / 16).

import { FIELD_SIZE, hm } from "./common.wgsl";

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  return vec4f(hm((position.xy + 0.5) / FIELD_SIZE), 0.0, 0.0, 1.0);
}
