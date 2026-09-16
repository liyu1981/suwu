import { registerBackground } from '../registry'

/**
 * Interactive Fluid — a pointer-driven GPU fluid solver (ported from the vgpu
 * "Interactive Fluid" example). GPU only: there is no CPU backend, so browsers
 * without WebGPU simply render no background.
 */
registerBackground({
  id: 'interactive-fluid',
  label: 'Interactive Fluid',
  gpu: () => import('./interactive-fluid-gpu'),
})
