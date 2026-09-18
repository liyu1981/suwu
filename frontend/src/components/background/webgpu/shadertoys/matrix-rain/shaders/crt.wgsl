// CRT post pass: barrel curvature, phosphor bloom, scanlines, aperture grille,
// radial chromatic aberration, vignette, and a faint flicker. Samples the rain
// rendered into the offscreen target.

const PI: f32 = 3.141592653589793;

struct CrtParams {
  output_size: vec2f,
  time: f32,
  curvature: f32,
  scanline: f32,
  aberration: f32,
  vignette: f32,
  bloom: f32,
  flicker: f32,
}

@group(0) @binding(0) var<uniform> params: CrtParams;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

fn curve(uv: vec2f) -> vec2f {
  let centered = uv - 0.5;
  return uv + centered * (dot(centered, centered) * params.curvature);
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let warped = curve(uv);
  // Outside the tube: black bezel.
  if (warped.x < 0.0 || warped.x > 1.0 || warped.y < 0.0 || warped.y > 1.0) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }

  // Radial chromatic aberration: the shadow-mask spreads colour toward edges.
  let dir = warped - 0.5;
  let offset = dir * params.aberration;
  let red = textureSampleLevel(src, samp, warped + offset, 0.0).r;
  let green = textureSampleLevel(src, samp, warped, 0.0).g;
  let blue = textureSampleLevel(src, samp, warped - offset, 0.0).b;
  var color = vec3f(red, green, blue);

  // Phosphor bloom: a few wide taps approximate a soft glow.
  let texel = 1.0 / params.output_size;
  let radius = texel * 3.0;
  var bloom = vec3f(0.0);
  bloom += textureSampleLevel(src, samp, warped + vec2f(radius.x, 0.0), 0.0).rgb;
  bloom += textureSampleLevel(src, samp, warped - vec2f(radius.x, 0.0), 0.0).rgb;
  bloom += textureSampleLevel(src, samp, warped + vec2f(0.0, radius.y), 0.0).rgb;
  bloom += textureSampleLevel(src, samp, warped - vec2f(0.0, radius.y), 0.0).rgb;
  bloom += textureSampleLevel(src, samp, warped + radius, 0.0).rgb;
  bloom += textureSampleLevel(src, samp, warped - radius, 0.0).rgb;
  bloom += textureSampleLevel(src, samp, warped + vec2f(radius.x, -radius.y), 0.0).rgb;
  bloom += textureSampleLevel(src, samp, warped + vec2f(-radius.x, radius.y), 0.0).rgb;
  color += bloom * (params.bloom * 0.125);

  // Scanlines locked to output rows.
  let scan = 0.5 + 0.5 * sin(uv.y * params.output_size.y * PI);
  color *= mix(1.0, 0.45 + 0.55 * scan, params.scanline);

  // Aperture grille: faint RGB triads across output columns.
  let triad = (floor(uv.x * params.output_size.x) % 3.0);
  let mask = vec3f(
    select(0.82, 1.0, triad < 1.0),
    select(0.82, 1.0, triad >= 1.0 && triad < 2.0),
    select(0.82, 1.0, triad >= 2.0),
  );
  color *= mix(vec3f(1.0), mask, 0.5);

  // Vignette: the tube dims toward the corners.
  let v = uv - 0.5;
  color *= clamp(1.0 - params.vignette * dot(v, v) * 2.0, 0.0, 1.0);

  // Subtle mains hum / flicker.
  color *= 1.0 - params.flicker * (0.5 + 0.5 * sin(params.time * 37.0));

  return vec4f(color, 1.0);
}
