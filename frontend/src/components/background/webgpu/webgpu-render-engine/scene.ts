import { frame, frameLoop } from 'vgpu'
import type { Frame, FrameLoopHandle, Gpu, Surface } from 'vgpu'
import { openGpuHost } from './host'
import type { GpuHostOptions } from './host'
import { elapsedSeconds } from './time'
import type { BackgroundContext, BackgroundHandle } from '../../types'

/**
 * A running WebGPU renderer: one frame's worth of encoding plus its lifecycle.
 *
 * Implemented by `fragmentScene()` for the declarative pass pipelines, and
 * hand-written by backgrounds that own their simulation stepping
 * (interactive-fluid). The engine drives the loop for all of them, so a scene
 * never starts its own `requestAnimationFrame`.
 */
export interface GpuScene {
  /** Re-size the scene's internal targets after a surface resize. */
  resize(size: readonly [number, number]): void
  /** Encode one frame into the engine's current `Frame`. */
  render(current: Frame, time: number): void
  /** Pre-compile every pass for the surface, so the first frame does not hitch. */
  prepare?(): Promise<void>
  /**
   * Reduced motion: run a still. Scenes settle their accumulation (if any) and
   * present one frame; the engine calls it to paint the initial static image.
   */
  settle?(): void
  /**
   * Re-present a still after a resize. Defaults to `settle()`. Override when
   * settling again would be wrong or wasteful (interactive-fluid keeps its
   * field across a resize, so it only needs to re-present).
   */
  present?(): void
  /** Release scene-owned resources not owned by the device (e.g. DOM listeners). */
  destroy(): void
}

export interface GpuSceneInit {
  readonly gpu: Gpu
  readonly surface: Surface
  /** The surface's current backing size, in device pixels. */
  readonly size: readonly [number, number]
  readonly params: Record<string, unknown>
  readonly ctx: BackgroundContext
}

export type GpuSceneFactory = (init: GpuSceneInit) => GpuScene | Promise<GpuScene>

/**
 * Runs a WebGPU background.
 *
 * Owns the lifecycle every GPU background repeated: device + surface creation,
 * device-lost reporting through `ctx.onFatal`, error logging, the resize →
 * deferred-redraw wiring, the frame loop (shared `ctx.fps`), reduced-motion
 * settling, and an idempotent teardown. The scene supplies only what is
 * specific to the effect.
 */
export async function startGpuBackground(
  label: string,
  createScene: GpuSceneFactory,
  ctx: BackgroundContext,
  params?: Record<string, unknown>,
  options?: Omit<GpuHostOptions, 'label'>,
): Promise<BackgroundHandle> {
  const host = await openGpuHost(ctx, { label, ...options })

  let disposed = false
  let scene: GpuScene | undefined
  let loop: FrameLoopHandle | undefined
  let unsubscribeResize: (() => void) | undefined
  let pendingRedraw = 0

  const encode = (current: Frame): void => {
    if (!scene) return
    scene.render(current, elapsedSeconds())
  }

  // Reduced motion (and every resize while reduced) presents a settled still.
  const still = (fresh: boolean): void => {
    if (disposed || !scene) return
    const primary = fresh ? scene.settle : (scene.present ?? scene.settle)
    const fallback = fresh ? scene.present : scene.settle
    if (primary) primary.call(scene)
    else if (fallback) fallback.call(scene)
    else frame(host.gpu, encode)
  }

  const teardown = (): void => {
    if (disposed) return
    disposed = true
    if (pendingRedraw) cancelAnimationFrame(pendingRedraw)
    loop?.stop()
    unsubscribeResize?.()
    scene?.destroy()
    host.teardown()
  }

  try {
    scene = await createScene({
      gpu: host.gpu,
      surface: host.surface,
      size: host.surface.size,
      params: params ?? {},
      ctx,
    })

    unsubscribeResize = host.surface.onResize(({ width, height }) => {
      if (disposed || !scene) return
      scene.resize([width, height])
      // frame() must not run inside the resize callback, so defer a redraw.
      if (ctx.reducedMotion) {
        cancelAnimationFrame(pendingRedraw)
        pendingRedraw = requestAnimationFrame(() => still(false))
      }
    })

    await scene.prepare?.()

    if (ctx.reducedMotion) {
      still(true)
    } else {
      loop = frameLoop(host.gpu, encode, { fps: ctx.fps })
    }

    return { backend: 'gpu', dispose: teardown }
  } catch (error) {
    teardown()
    throw error
  }
}
