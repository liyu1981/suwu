import { registerBackground } from '../registry'

/**
 * Atmospheric Landscape — a slow volumetric fly-over of a foggy, sunlit
 * terrain (ray-marched ground SDF + emissive/absorbing fog and air).
 *
 * GPU only: one fragment pass ray-marches the scene into a ping-pong
 * accumulation target, a second pass applies the contrast/sRGB tone curve to
 * the canvas. Ported from the Shadertoy demo "Atmospheric Landscape" by TekF
 * (https://www.shadertoy.com/view/slVfD1); see the shaders for the adaptation
 * notes.
 */
registerBackground({
  id: 'atmospheric-landscape',
  label: 'Atmospheric Landscape',
  gpu: () => import('./atmospheric-landscape-gpu'),
})
