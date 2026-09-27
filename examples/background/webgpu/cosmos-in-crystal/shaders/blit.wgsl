// Upscales the capped Cosmos in Crystal render target onto the canvas.

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(textureSampleLevel(src, samp, uv, 0.0).rgb, 1.0);
}
