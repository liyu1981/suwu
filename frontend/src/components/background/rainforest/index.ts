import { registerBackground } from '../registry'
import { WEBGPU_ENGINE } from '../constants'
import { RAINFOREST_PARAMS } from './params'

/**
 * Rainforest — a raymarched forest landscape with analytic normals.
 *
 * GPU only. Ported to WGSL/vgpu from "Rainforest" by Inigo Quilez (iq), 2016 —
 * https://www.shadertoy.com/view/4ttSWf — https://iquilezles.org/
 *
 * The original carries a restrictive license that forbids use in any product;
 * it is included here with express permission from the author. Keep that
 * permission on file and cite the author if this is redistributed.
 */
registerBackground({
  id: 'rainforest',
  label: 'Rainforest',
  engine: WEBGPU_ENGINE,
  params: RAINFOREST_PARAMS,
  gpu: () => import('./rainforest-gpu'),
})
