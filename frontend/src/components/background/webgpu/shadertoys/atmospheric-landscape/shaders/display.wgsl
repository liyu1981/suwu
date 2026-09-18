// Atmospheric Landscape — final tone pass.
//
// Ported from the Image pass of "Atmospheric Landscape" by TekF —
// https://www.shadertoy.com/view/slVfD1. Contrast stretch followed by a linear
// to sRGB transfer, matching the original.

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

fn linear_to_srgb(col: vec3f) -> vec3f {
  return mix(col * 12.92, 1.055 * pow(col, vec3f(1.0 / 2.4)) - 0.055, step(vec3f(0.0031308), col));
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  var color = textureSampleLevel(src, samp, uv, 0.0).rgb;

  let low = vec3f(0.05, 0.06, 0.08) * 2.0;
  let high = vec3f(1.0) - vec3f(0.05, 0.06, 0.08);
  color = smoothstep(low, high, color);

  color = linear_to_srgb(color);
  return vec4f(color, 1.0);
}
