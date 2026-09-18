import type { BackgroundEngine } from './types';

/** Background used when the user has not chosen one (or the stored id is stale). */
export const DEFAULT_BACKGROUND_ID = 'ambient-blob';

/**
 * The shared GPU render engine (`background/webgpu/webgpu-render-engine/`).
 * Backgrounds that declare this engine are grouped under one "WebGPU" selector
 * in System Settings.
 */
export const WEBGPU_ENGINE: BackgroundEngine = 'webgpu-render-engine';
