import { blob_falloff } from "./common.wgsl";

// One blob: a radial gradient centre + radius, and a colour whose alpha is the
// peak contribution. The seed motion is computed on the CPU and packed here so
// the CPU and GPU backends share identical positions and colours.
struct Blob {
  center: vec2f,
  radius: f32,
  color: vec4f,
};

struct Params {
  resolution: vec2f,
  blobs: array<Blob, 12>,
};

@group(0) @binding(0) var<uniform> params: Params;

const BLOB_COUNT: i32 = 12;
const CORE_STOP: f32 = 0.6;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let point = uv * params.resolution;
  var rgb = vec3f(0.0);
  var alpha = 0.0;

  for (var i = 0; i < BLOB_COUNT; i = i + 1) {
    let blob = params.blobs[i];
    let falloff = blob_falloff(distance(point, blob.center), blob.radius, CORE_STOP);
    let contribution = blob.color.a * falloff;
    rgb = rgb + blob.color.rgb * contribution;
    alpha = alpha + contribution;
  }

  // Match canvas-2D `globalCompositeOperation = 'lighter'` accumulation and
  // write premultiplied alpha so the canvas composites over `.ambient-bg`.
  return vec4f(rgb, min(alpha, 1.0));
}
