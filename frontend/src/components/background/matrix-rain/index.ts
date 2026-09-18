import { registerBackground } from '../registry'
import { WEBGPU_ENGINE } from '../constants'

/**
 * Matrix Rain — falling green glyph columns on black (the classic Matrix
 * "digital rain"). GPU only: the glyph atlas lives in a read-only storage
 * buffer and the effect is a single procedural fragment shader.
 */
registerBackground({
  id: 'matrix-rain',
  label: 'Matrix Rain',
  engine: WEBGPU_ENGINE,
  gpu: () => import('./matrix-rain-gpu'),
})
