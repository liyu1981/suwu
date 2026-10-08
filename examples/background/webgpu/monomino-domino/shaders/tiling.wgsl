// Back-buffer pass of the Monomino Domino port: the tiling itself.
//
// The original's Buffer A runs at canvas resolution and returns early outside
// a 32×32 wrapping area; here the pass *is* 32×32 — one fragment per cell —
// and it ping-pongs against the previous frame's state, exactly like the
// Shadertoy back-buffer. Every frame each empty cell rolls a random direction
// (seeded by position + frame); if two empty neighbours point at one another
// they link into a 1×2 domino and lock. Pre-seeded 1×1 monominos punch holes
// in the pairing. The process settles on its own, which is why the scene can
// read a stable tiling after a second or two.
//
// The original's deliberate "time delay" — a flicker that lets you watch the
// pattern assemble at ~160/8 updates per second — is kept: the host computes
// the gate from the scaled clock and passes it in, so animation speed paces
// the assembly too, and 0 lets it complete while everything else stands still.

import { GRID_SIZE, dir_to_index, hash21, rnd_dir, wrap2 } from "./common.wgsl";

struct StepInfo {
  // Buffer frame counter: the first step (0) initializes the grid; the
  // original's iFrame feeds the direction hashes the same way.
  frame: f32,
  // 1 = hold (the original's delay flicker), 0 = attempt an update.
  gate: f32,
  _pad: vec2f,
}

@group(0) @binding(0) var<uniform> info: StepInfo;
// Previous frame's cell state (the original's iChannel0).
@group(0) @binding(1) var buf_in: texture_2d<f32>;

// The wrapped cell state — the original's tx().
fn tx(coord: vec2f) -> vec4f {
  return textureLoad(buf_in, vec2i(wrap2(coord, GRID_SIZE)), 0);
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let ip = floor(position.xy);

  // Initializing: zero out every cell, force a share of them to monominos
  // (nonzero, so they never link, but they cast to integer zero — no joiner
  // edges), and store each cell's position ID in .y. The original also
  // re-initializes on mouse-down; there is no pointer here.
  if (info.frame < 0.5) {
    var a = vec4f(0.0);
    if (hash21(ip + 0.11) < 0.15) {
      a.x = 0.01;
    }
    a.y = ip.y * GRID_SIZE + ip.x;
    return a;
  }

  let coord = vec2i(wrap2(ip, GRID_SIZE));

  // The deliberate time delay: hold the current state (a no-op copy).
  if (info.gate > 0.5) {
    return textureLoad(buf_in, coord, 0);
  }

  // Roll this cell's direction and its neighbour's; a link is made only when
  // both cells are empty and point at one another, so the pair agrees on the
  // same decision from either side and locks in a domino.
  var a = textureLoad(buf_in, coord, 0);
  let dir = rnd_dir(vec3f(ip, info.frame));
  let nb = wrap2(ip + dir, GRID_SIZE);
  let dir_ngbr = rnd_dir(vec3f(nb, info.frame));
  let col_ngbr = tx(nb);
  let dir_index = dir_to_index(dir) + 1.0;

  if (a.x == 0.0 && col_ngbr.x == 0.0 && dir.x == -dir_ngbr.x && dir.y == -dir_ngbr.y) {
    a.x = dir_index;
  }
  return a;
}
