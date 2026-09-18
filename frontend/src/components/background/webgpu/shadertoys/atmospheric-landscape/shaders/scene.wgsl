// Atmospheric Landscape — volumetric terrain, fog and air.
//
// Ported to WGSL/vgpu from the Buffer A pass of "Atmospheric Landscape" by
// TekF — https://www.shadertoy.com/view/slVfD1 (Shadertoy, 2022).
//
// Adaptation notes:
//   * The original renders at the full canvas resolution and stores its dynamic
//     resolution scale in a corner texel, then reconstructs a lower-res sample
//     with per-pixel feedback. Here the whole scene runs into a fixed
//     lower-resolution ping-pong accumulation target instead, so the feedback
//     read is a plain `textureSampleLevel` at the same texel.
//   * `iChannel1` (a 32³ RGBA noise volume sampled `pos/32`) becomes a
//     CPU-generated 64³ volume sampled `pos/64` — identical world-space feature
//     size, no asset to ship.
//   * WebGPU fragment coordinates are top-down while GLSL's are bottom-up, so
//     `frag_coord.y` is flipped; the accumulation read uses the unflipped
//     position-derived UV to stay aligned with the stored texture.

import { hashU32, unitFloat } from "@vgpu/wgsl-std/hash";

// -- Bindings ---------------------------------------------------------------

struct Params {
  resolution: vec2f,
  time: f32,
  frame: f32,
  blend: f32,
  _pad: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var prev_frame: texture_2d<f32>;
@group(0) @binding(2) var prev_sampler: sampler;
@group(0) @binding(3) var noise_volume: texture_3d<f32>;
@group(0) @binding(4) var noise_sampler: sampler;

// -- Helpers ----------------------------------------------------------------

// Irrational-ish 2-vector driving the per-pixel jitter (same constants as the original).
const QUASI2 = vec2f(0.754877666247, 0.569840290998);
const NOISE_SIZE: f32 = 64.0;
const MAX_STEPS: i32 = 200;

// One noise sample: trilinear fetch of the random volume, remapped to [-1, 1].
fn noise(pos: vec3f) -> f32 {
  return textureSampleLevel(noise_volume, noise_sampler, pos / NOISE_SIZE, 0.0).r * 2.0 - 1.0;
}

// Terrain height field: the sum of |noise| over a rotating octave chain.
fn ground_sdf(pos: vec3f, octaves: i32) -> f32 {
  var f = 0.0;
  var s = 1.4;
  var p = pos * s * 0.1;

  for (var i = 0; i < octaves; i = i + 1) {
    f = f + abs(noise(p)) * s;
    p = vec3f(p.z * 5.0, p.xy * 3.0 + p.yx * 4.0 * vec2f(1.0, -1.0)) * 2.0 / 5.0;
    s = s / 2.0;
  }

  return (pos.y + f) * 0.8;
}

// Emissive, absorbing fog: octaves of signed noise plus a low ground layer and
// a cloud layer, carved away where the terrain is solid.
fn fog_density(pos: vec3f, octaves: i32, time: f32) -> f32 {
  var f = 0.0;
  var s = 1.0;
  var p = pos * 0.7;

  p = p + time * vec3f(0.0, -0.02, 0.02);

  for (var i = 0; i < octaves; i = i + 1) {
    f = f + noise(p) * s;
    p = vec3f(p.z * 5.0, p.xy * 3.0 + p.yx * 4.0 * vec2f(1.0, -1.0)) * 2.0 / 5.0;
    s = s / 1.7;
  }

  // Low ground layer.
  f = f + (1.0 - smoothstep(0.0, 0.2, abs(pos.y + 1.0))) * 0.4;
  // Cloud layer.
  f = f + (1.0 - smoothstep(0.2, 0.4, abs(pos.y - 0.3))) * 0.7;

  f = smoothstep(0.2, 1.5, f);

  let g = ground_sdf(pos, 2);
  f = f * (1.0 - g / (abs(g) + 0.04));

  return f;
}

// Exponential height falloff for the clear air.
fn air_density(pos: vec3f) -> f32 {
  return exp2(-pos.y / 5.0 - 3.0);
}

// -- Scene pass -------------------------------------------------------------

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let res = params.resolution;
  let raw_time = params.time;

  // GLSL fragment coordinates are bottom-up; WebGPU's are top-down.
  let frag_coord = vec2f(position.x, res.y - position.y);
  // Accumulation read uses the stored (top-down) orientation.
  let uv = position.xy / res;

  // Black bars, for a 2.39:1 cinematic frame.
  if (abs(frag_coord.y - res.y * 0.5) > res.x * 0.5 / 2.39) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }

  // `params.time` is already speed-scaled by the host (see renderer TIME_SCALE);
  // the 0.2 is the original's own camera-time factor.
  let time = raw_time * 0.2;
  let velocity = vec3f(1.0, 0.0, 0.0);
  let zoom = 1.0;
  var cam_pos = vec3f(sin(time * 0.618) * 0.4, -0.3 + 0.1 * sin(time), 0.0) + time * velocity;
  let cam_look = vec3f(-1.0, -0.5, 4.0) + (time - sin(time)) * velocity;

  // Per-pixel, per-frame jitter: precession that spreads samples evenly.
  let jitter_seed = unitFloat(hashU32(u32(frag_coord.x) ^ (u32(frag_coord.y) * 0x9e3779b9u)));
  let jitter = fract(QUASI2 * (params.frame + jitter_seed));

  var ray = vec3f((frag_coord + jitter - res * 0.5) / (res.x * zoom), 1.0);
  let cam_dir = normalize(cam_look - cam_pos);
  let cam_right = normalize(cross(vec3f(0.0, 1.0, 0.0), cam_dir));
  let cam_up = cross(cam_dir, cam_right);
  ray = ray.x * cam_right + ray.y * cam_up + ray.z * cam_dir;

  // Depth of field: offset the origin and ray for a shallow aperture.
  let focal_depth = 4.0;
  let aperture = 0.003;
  cam_pos = cam_pos + ray * focal_depth;
  ray = ray + ((jitter.y * 2.0 - 1.0) * cam_right + (jitter.x * 2.0 - 1.0) * cam_up) * aperture;
  cam_pos = cam_pos - ray * focal_depth;
  ray = normalize(ray);

  let sun_dir = normalize(vec3f(-3.0, 2.0, 1.0));

  // March the ground while accumulating emissive/absorbing fog and air.
  var pos = cam_pos;
  var absorption = vec3f(1.0);
  var emission = vec3f(0.0);
  var last_stride = 0.0;
  var last_fog = 0.0;
  var last_air = 0.0;

  for (var i = 0; i < MAX_STEPS; i = i + 1) {
    var h = ground_sdf(pos, 6);

    let fog = fog_density(pos, 6, raw_time);
    let fog_integral = last_stride * mix(fog, last_fog, 0.5);
    let air = air_density(pos);
    let air_integral = last_stride * mix(air, last_air, 0.5);

    let fog_absorption = pow(vec3f(0.1), vec3f(fog_integral));
    var fog_emission = 1.0 - pow(vec3f(0.1), vec3f(fog_integral));

    // Fog lighting: sample toward the sun and subtract.
    let shadow_step = 0.07;
    let shadow = (fog - fog_density(pos + sun_dir * shadow_step, 3, raw_time)) / shadow_step;
    fog_emission = fog_emission * mix(
      vec3f(0.2, 0.27, 0.35) * 0.4,
      vec3f(1.0) * 0.6,
      smoothstep(-1.0, 1.0, shadow),
    );

    let air_absorption = pow(1.0 - vec3f(0.3, 0.48, 0.7), vec3f(air_integral));
    let air_emission = (1.0 - pow(1.0 - vec3f(0.4, 0.55, 0.7), vec3f(air_integral))) * 0.6;

    let delta = fog_absorption * air_absorption;
    emission = emission + (absorption * sqrt(delta)) * (fog_emission + air_emission);
    absorption = absorption * delta;

    last_fog = fog;
    last_air = air;

    h = min(h, 0.1); // fog step
    last_stride = h;
    pos = pos + h * ray;
    if (h < 0.001) {
      break;
    }
  }

  // Terrain lighting with a tetrahedral normal.
  let d = vec2f(-1.0, 1.0) * 0.02;
  let normal = normalize(
    ground_sdf(pos + d.xxx, 6) * d.xxx
      + ground_sdf(pos + d.xyy, 6) * d.xyy
      + ground_sdf(pos + d.yxy, 6) * d.yxy
      + ground_sdf(pos + d.yyx, 6) * d.yyx,
  );

  let aostep = 0.3;
  let ao = smoothstep(-0.2, 1.5, ground_sdf(pos + normal * aostep, 6) / aostep);

  var color = vec3f(0.5) * ao + vec3f(0.5) * max(dot(normal, sun_dir), 0.0);
  color = color * (0.4 * mix(vec3f(0.0, 0.2, 0.0), vec3f(0.07, 0.1, 0.0) + 0.3, smoothstep(0.3, 0.9, ao)));
  if (ground_sdf(pos, 6) > 0.5) {
    color = vec3f(0.14);
  }
  color = color * absorption + emission;

  // Temporal accumulation against the previous frame (replaces the original's
  // dynamic-resolution feedback read).
  let previous = textureSampleLevel(prev_frame, prev_sampler, uv, 0.0).rgb;
  color = mix(previous, color, params.blend);

  return vec4f(color, 1.0);
}
