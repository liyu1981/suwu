// Pure helpers for the Matrix rain effect. No bindings here — the entry shader
// owns the bind group layout.

// Brightness along a column's trail: 1.0 at the head, fading to 0 at `trail`.
export fn rain_brightness(distance: f32, trail: f32) -> f32 {
  let falloff = pow(clamp(1.0 - distance / trail, 0.0, 1.0), 1.8);
  return select(falloff, 1.0, distance < 1.0);
}
