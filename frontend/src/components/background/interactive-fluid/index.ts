import { registerBackground } from '../registry'
import { WEBGPU_ENGINE } from '../constants'

/**
 * Interactive Fluid — a pointer-driven GPU fluid solver (ported from the vgpu
 * "Interactive Fluid" example). GPU only: there is no CPU backend, so browsers
 * without WebGPU simply render no background.
 */
registerBackground({
  id: 'interactive-fluid',
  label: 'Interactive Fluid',
  engine: WEBGPU_ENGINE,
  gpu: () => import('./interactive-fluid-gpu'),
})
