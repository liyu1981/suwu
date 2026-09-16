import { registerBackground } from '../registry'
import { AMBIENT_BLOB_DEFAULTS } from './params'

/**
 * The ambient blob field — the default Suwu app-shell background.
 *
 * CPU and GPU implementations live in nested folders (`ambient-blob-cpu`,
 * `ambient-blob-gpu`) and are loaded lazily by the selector. This module only
 * declares the definition and its shared parameters.
 */
registerBackground({
  id: 'ambient-blob',
  label: 'Ambient Blob',
  defaultParams: AMBIENT_BLOB_DEFAULTS,
  cpu: () => import('./ambient-blob-cpu'),
  gpu: () => import('./ambient-blob-gpu'),
})
