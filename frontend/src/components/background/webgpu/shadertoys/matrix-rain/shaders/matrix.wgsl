import { hashU32, hash1 } from "@vgpu/wgsl-std/hash";
import { rain_brightness } from "./common.wgsl";

// The glyph atlas is a 1-bit-per-pixel bitmap grid uploaded once by the host.
// These constants must match glyph-atlas.ts (GLYPH_WIDTH / GLYPH_HEIGHT).
const GLYPH_W: u32 = 24u;
const GLYPH_H: u32 = 30u;
const WORDS_PER_GLYPH: u32 = 23u; // ceil(24 * 30 / 32)

const SPEED_MIN: f32 = 1.5; // cells / second — slow, heavy rain
const SPEED_MAX: f32 = 6.0;
const TRAIL_MIN: f32 = 10.0; // trail length in cells, randomised per column
const TRAIL_MAX: f32 = 26.0;
const CHANGE_MIN: f32 = 0.35; // seconds between glyph mutations, per column
const CHANGE_MAX: f32 = 1.4;

const TRAIL_COLOR = vec3f(0.06, 0.9, 0.26);
const HEAD_COLOR = vec3f(0.78, 1.0, 0.85);
const GLOW_COLOR = vec3f(0.1, 0.85, 0.35);

struct Params {
  resolution: vec2f,
  cell: vec2f,
  time: f32,
  glyph_count: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> glyphs: array<u32>;

// One glyph bit: 1 when the pixel is inked, else 0.
fn glyph_bit(glyph: u32, gx: u32, gy: u32) -> f32 {
  let bit = gy * GLYPH_W + gx;
  let word = glyphs[glyph * WORDS_PER_GLYPH + bit / 32u];
  return f32((word >> (bit % 32u)) & 1u);
}

// Ink in the four neighbouring glyph pixels — the phosphor bloom source.
fn glyph_glow(glyph: u32, gx: u32, gy: u32) -> f32 {
  let left = u32(max(i32(gx) - 1, 0));
  let right = min(gx + 1u, GLYPH_W - 1u);
  let up = u32(max(i32(gy) - 1, 0));
  let down = min(gy + 1u, GLYPH_H - 1u);
  let axis = glyph_bit(glyph, left, gy)
    + glyph_bit(glyph, right, gy)
    + glyph_bit(glyph, gx, up)
    + glyph_bit(glyph, gx, down);
  return min(axis * 0.5, 1.0);
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let px = uv * params.resolution;
  let col = floor(px.x / params.cell.x);
  let row = floor(px.y / params.cell.y);
  let rows = ceil(params.resolution.y / params.cell.y);

  // Every column is independent: speed, trail, mutation rate, brightness, and
  // an occasional "quiet" column all come from different hashes, so the rain
  // never falls into a visible rhythm.
  let speed = mix(SPEED_MIN, SPEED_MAX, hash1(col + 0.5));
  let trail = mix(TRAIL_MIN, TRAIL_MAX, hash1(col + 7.3));
  let change = mix(CHANGE_MIN, CHANGE_MAX, hash1(col + 61.7));
  let column_gain = mix(0.5, 1.0, hash1(col + 19.1));
  let quiet = select(1.0, 0.12, hash1(col + 83.3) < 0.12);

  let span = rows + trail;
  let phase = hash1(col + 41.5) * span;
  let head = (params.time * speed + phase) % span;

  let distance = head - row;
  if (distance < 0.0 || distance > trail) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }

  let bright = rain_brightness(distance, trail) * column_gain * quiet;

  let tick = u32(floor(params.time / change));
  let seed = hashU32((u32(col) * 0x9E3779B1u) ^ (u32(row) * 0x85EBCA6Bu) ^ (tick * 0xC2B2AE35u));
  let glyph = seed % max(params.glyph_count, 1u);

  let local = px - vec2f(col, row) * params.cell;
  let gx = u32(clamp(floor(local.x / params.cell.x * f32(GLYPH_W)), 0.0, f32(GLYPH_W - 1u)));
  let gy = u32(clamp(floor(local.y / params.cell.y * f32(GLYPH_H)), 0.0, f32(GLYPH_H - 1u)));

  let core = glyph_bit(glyph, gx, gy);
  let glow = glyph_glow(glyph, gx, gy);

  let tint = mix(TRAIL_COLOR, HEAD_COLOR, smoothstep(0.0, 1.5, distance));
  // CRT phosphor: a crisp core plus a soft bloom that fills the glyph gaps.
  var color = tint * bright * clamp(core + glow * 0.35, 0.0, 1.0);
  color += GLOW_COLOR * bright * glow * 0.45;
  return vec4f(color, 1.0);
}
