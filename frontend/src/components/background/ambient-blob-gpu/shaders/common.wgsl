// Shared helpers for the ambient blob field.

// Falloff for the three-stop radial gradient: solid out to `core` (a fraction
// of the radius) and then linear to zero at the radius. Mirrors the canvas-2D
// gradient stops `[0, core] -> solid, 1 -> transparent`.
export fn blob_falloff(distance_from_center: f32, radius: f32, core: f32) -> f32 {
  let core_radius = radius * core;
  let tail = max(radius - core_radius, 0.0001);
  return clamp((radius - distance_from_center) / tail, 0.0, 1.0);
}
