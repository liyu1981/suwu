import { registerBackground } from '../registry';
import { AMBIENT_BLOB_DEFAULTS } from './params';
import type { BackgroundParam } from '../types';

/** Palette choice — the one thing the ambient blob exposes to System Settings. */
const AMBIENT_BLOB_PARAMS: readonly BackgroundParam[] = [
  {
    kind: 'select',
    key: 'palette',
    label: 'Palette',
    default: AMBIENT_BLOB_DEFAULTS.palette,
    options: [
      { value: 'auto', label: 'Auto (match theme)' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ],
  },
];

/**
 * The ambient blob field — the default Suwu app-shell background.
 *
 * CPU and GPU implementations live in nested folders (`ambient-blob-cpu`,
 * `ambient-blob-gpu`) and are loaded lazily by the selector. This module only
 * declares the definition, its parameters and their defaults.
 */
registerBackground({
  id: 'ambient-blob',
  label: 'Ambient Blob',
  params: AMBIENT_BLOB_PARAMS,
  cpu: () => import('./ambient-blob-cpu'),
  gpu: () => import('./ambient-blob-gpu'),
});
