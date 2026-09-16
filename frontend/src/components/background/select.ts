import type {
  BackendKind,
  BackgroundContext,
  BackgroundDefinition,
  BackgroundHandle,
} from './types'

export interface StartBackgroundOptions {
  /** `'auto'` (default) tries the GPU backend first, then falls back to CPU. */
  force?: BackendKind | 'auto'
}

const DEBUG_KEY = 'suwu.bg'

/** Debug override: `?bg=gpu|cpu|auto`, then localStorage, then undefined. */
function debugOverride(): BackendKind | 'auto' | undefined {
  if (typeof window === 'undefined') return undefined
  const fromQuery = new URLSearchParams(window.location.search).get('bg')
  if (fromQuery === 'gpu' || fromQuery === 'cpu' || fromQuery === 'auto') return fromQuery
  try {
    const fromStorage = window.localStorage.getItem(DEBUG_KEY)
    if (fromStorage === 'gpu' || fromStorage === 'cpu' || fromStorage === 'auto') return fromStorage
  } catch {
    // localStorage may be unavailable (private mode, disabled storage).
  }
  return undefined
}

function hasWebGpu(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    (navigator as Navigator & { gpu?: unknown }).gpu != null
  )
}

/**
 * Starts a background, preferring the GPU backend when WebGPU is available.
 *
 * The GPU backend initialises its device before creating a surface on the
 * canvas, so a plain "WebGPU unsupported" failure leaves the canvas free for
 * the CPU fallback. If even the CPU backend fails, the canvas context was
 * most likely tainted by a partially-created WebGPU context, so we report a
 * fatal error and let the caller remount a fresh canvas.
 */
export async function startBackground(
  definition: BackgroundDefinition,
  ctx: BackgroundContext,
  options: StartBackgroundOptions = {},
): Promise<BackgroundHandle> {
  const force = options.force ?? debugOverride() ?? 'auto'

  if (force !== 'cpu' && definition.gpu && hasWebGpu()) {
    try {
      const gpuModule = await definition.gpu()
      return await gpuModule.start(ctx, definition.defaultParams)
    } catch (error) {
      console.warn('[background] GPU backend failed; falling back to CPU', error)
    }
  }

  try {
    const cpuModule = await definition.cpu()
    return await cpuModule.start(ctx, definition.defaultParams)
  } catch (error) {
    ctx.onFatal(error)
    throw error
  }
}
