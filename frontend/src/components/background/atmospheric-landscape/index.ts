import { registerBackground } from '../registry'
import { WEBGPU_ENGINE } from '../constants'
import { ATMOSPHERIC_LANDSCAPE_PARAMS } from './params'

/**
 * Atmospheric Landscape — a slow volumetric fly-over of a foggy, sunlit
 * terrain (ray-marched ground SDF + emissive/absorbing fog and air).
 *
 * GPU only: one fragment pass ray-marches the scene into a ping-pong
 * accumulation target, a second pass applies the contrast/sRGB tone curve to
 * the canvas. Ported from the Shadertoy demo "Atmospheric Landscape" by TekF
 * (https://www.shadertoy.com/view/slVfD1); see the shaders for the adaptation
 * notes. Exposes an adjustable animation speed.
 */
registerBackground({
  id: 'atmospheric-landscape',
  label: 'Atmospheric Landscape',
  engine: WEBGPU_ENGINE,
  params: ATMOSPHERIC_LANDSCAPE_PARAMS,
  gpu: () => import('./atmospheric-landscape-gpu'),
})
