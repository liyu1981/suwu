import type {
  BackendKind,
  BackgroundContext,
  BackgroundDefinition,
  BackgroundHandle,
} from './types'
import { defaultBackgroundParams } from './params'

export interface StartBackgroundOptions {
  /** `'auto'` (default) tries the GPU backend first, then falls back to CPU. */
  force?: BackendKind | 'auto'
  /**
   * Resolved parameters bag. Callers usually pass `resolveBackgroundParams()`
   * output; when omitted the background's declared defaults are used.
   */
  params?: Record<string, unknown>
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
 *
 * Returns `null` when no backend can run — e.g. a GPU-only background in a
 * browser without WebGPU. In that case the canvas stays empty and no error is
 * reported (there is nothing to fall back to).
 */
export async function startBackground(
  definition: BackgroundDefinition,
  ctx: BackgroundContext,
  options: StartBackgroundOptions = {},
): Promise<BackgroundHandle | null> {
  const force = options.force ?? debugOverride() ?? 'auto'
  const params: Record<string, unknown> = options.params ?? defaultBackgroundParams(definition)

  if (force !== 'cpu' && definition.gpu && hasWebGpu()) {
    try {
      const gpuModule = await definition.gpu()
      return await gpuModule.start(ctx, params)
    } catch (error) {
      if (!definition.cpu) {
        console.warn(
          `[background] "${definition.id}" GPU backend failed and it has no CPU fallback`,
          error,
        )
        return null
      }
      console.warn('[background] GPU backend failed; falling back to CPU', error)
    }
  }

  if (definition.cpu) {
    try {
      const cpuModule = await definition.cpu()
      return await cpuModule.start(ctx, params)
    } catch (error) {
      ctx.onFatal(error)
      throw error
    }
  }

  // GPU-only background in a browser without WebGPU: render nothing.
  console.info(`[background] "${definition.id}" has no available backend on this browser`)
  return null
}
