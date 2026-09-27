// Vignette pass for the Rainforest background: samples the accumulated frame
// and applies the original Image pass's vignette. Ported from "Rainforest" by
// Inigo Quilez (https://www.shadertoy.com/view/4ttSWf), used with permission.

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let col = textureSampleLevel(src, samp, uv, 0.0).xyz;
  let vig = 0.5 + 0.5 * pow(16.0 * uv.x * uv.y * (1.0 - uv.x) * (1.0 - uv.y), 0.05);
  return vec4f(col * vig, 1.0);
}
