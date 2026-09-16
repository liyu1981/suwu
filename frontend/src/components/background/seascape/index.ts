import { registerBackground } from '../registry'
import { SEASCAPE_PARAMS } from './params'

/**
 * Seascape — a classic procedural, raymarched ocean.
 *
 * GPU only. Ported from "Seascape" by Alexander Alekseev aka TDM (2014),
 * https://www.shadertoy.com/view/Ms2SD1 — the author and URL are cited in the
 * shader and renderer. Adds an adjustable animation speed via System Settings.
 */
registerBackground({
  id: 'seascape',
  label: 'Seascape',
  params: SEASCAPE_PARAMS,
  gpu: () => import('./seascape-gpu'),
})
