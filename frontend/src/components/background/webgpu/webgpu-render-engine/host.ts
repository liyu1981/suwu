import { init, surface } from 'vgpu'
import type { ClearColor, Gpu, Surface } from 'vgpu'
import type { BackgroundContext } from '../../types'

/** Options for the canvas surface the host owns. */
export interface GpuHostOptions {
  /** Surface label, also used in error logs. */
  readonly label: string
  /** Default clear color; vgpu's default (`[0, 0, 0, 1]`) when omitted. */
  readonly clearColor?: ClearColor
  /** Canvas alpha mode; vgpu's default when omitted. */
  readonly alphaMode?: GPUCanvasAlphaMode
}

/** The device + canvas surface every GPU background renders into. */
export interface GpuHost {
  readonly gpu: Gpu
  readonly surface: Surface
  teardown(): void
}

/**
 * Creates the GPU device and attaches the canvas surface.
 *
 * The device is created *before* the surface touches the canvas, so a plain
 * "WebGPU unsupported" failure throws while the canvas is still free for a CPU
 * fallback. A device lost after the surface is attached reports through
 * `ctx.onFatal`, and the wrapper remounts a fresh canvas (a canvas context type
 * is permanent, so it cannot be reused).
 */
export async function openGpuHost(
  ctx: BackgroundContext,
  options: GpuHostOptions,
): Promise<GpuHost> {
  const gpu = await init({ powerPreference: 'low-power' })

  let disposed = false
  const offError = gpu.onError((error) => {
    console.warn(`[${options.label}] gpu error`, error)
  })
  void gpu.gpu.lost.then((info) => {
    if (!disposed && info.reason !== 'destroyed') ctx.onFatal(info)
  })

  let canvasSurface: Surface
  try {
    canvasSurface = surface(gpu, ctx.canvas, {
      dpr: ctx.dpr,
      clearColor: options.clearColor,
      alphaMode: options.alphaMode,
      label: options.label,
    })
  } catch (error) {
    offError()
    gpu.dispose()
    throw error
  }

  return {
    gpu,
    surface: canvasSurface,
    teardown() {
      if (disposed) return
      disposed = true
      offError()
      canvasSurface.dispose()
      gpu.dispose()
    },
  }
}
