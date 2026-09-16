import { clock, effect, frame, frameLoop, init, surface } from 'vgpu'
import type { Effect, Frame, FrameLoopHandle, Surface } from 'vgpu'
import {
  computeBlobFrame,
  makeBlobs,
  prefersReducedTransparency,
  resolveParams,
} from '../ambient-blob/params'
import type { BlobSeed } from '../ambient-blob/types'
import type { BackgroundContext, BackgroundHandle } from '../types'
import ambientShader from './shaders/ambient.wgsl'

interface BlobUniform {
  center: [number, number]
  radius: number
  color: [number, number, number, number]
}

function packBlobs(
  blobs: readonly BlobSeed[],
  t: number,
  width: number,
  height: number,
): BlobUniform[] {
  return computeBlobFrame(blobs, t, width, height).map((blob) => ({
    center: [blob.x, blob.y],
    radius: blob.radius,
    color: [blob.color[0], blob.color[1], blob.color[2], blob.alpha],
  }))
}

/**
 * WebGPU (vgpu) ambient blob renderer.
 *
 * The device is created before any surface touches the canvas, so a plain
 * "WebGPU unsupported" failure throws while the canvas is still free for the
 * CPU fallback. A device lost after the surface is attached reports through
 * `ctx.onFatal`, and the wrapper remounts a fresh canvas.
 */
export async function startAmbientBlobGpu(
  ctx: BackgroundContext,
  params?: Record<string, unknown>,
): Promise<BackgroundHandle> {
  const config = resolveParams(params)

  const gpu = await init({ powerPreference: 'low-power' })

  let disposed = false
  const offError = gpu.onError((error) => {
    console.warn('[ambient-blob-gpu] gpu error', error)
  })
  void gpu.gpu.lost.then((info) => {
    if (!disposed && info.reason !== 'destroyed') ctx.onFatal(info)
  })

  let canvasSurface: Surface
  try {
    canvasSurface = surface(gpu, ctx.canvas, {
      dpr: ctx.dpr,
      alphaMode: 'premultiplied',
      clearColor: [0, 0, 0, 0],
      label: 'ambient-blob',
    })
  } catch (error) {
    offError()
    gpu.dispose()
    throw error
  }

  const blobs = makeBlobs(config.palette, prefersReducedTransparency())
  let width = canvasSurface.size[0]
  let height = canvasSurface.size[1]
  const time = clock(gpu)

  const ambient: Effect = effect(gpu, ambientShader, {
    label: 'ambient-blob',
    set: { params: { resolution: [width, height], blobs: packBlobs(blobs, 0, width, height) } },
  })

  const encode = (current: Frame): void => {
    ambient.set({ params: { blobs: packBlobs(blobs, time.time, width, height) } })
    current.pass({ target: canvasSurface, clear: [0, 0, 0, 0] }, ambient)
  }

  // frame() must not run inside the resize callback, so defer redraws there.
  let pendingRedraw = 0
  const unsubscribeResize = canvasSurface.onResize(({ width: w, height: h }) => {
    width = w
    height = h
    ambient.set({ params: { resolution: [w, h], blobs: packBlobs(blobs, time.time, w, h) } })
    if (ctx.reducedMotion && !disposed) {
      cancelAnimationFrame(pendingRedraw)
      pendingRedraw = requestAnimationFrame(() => {
        if (!disposed) frame(gpu, encode)
      })
    }
  })

  let loop: FrameLoopHandle | null = null
  if (ctx.reducedMotion) {
    frame(gpu, encode)
  } else {
    loop = frameLoop(gpu, encode, { fps: ctx.fps })
  }

  return {
    backend: 'gpu',
    dispose() {
      disposed = true
      cancelAnimationFrame(pendingRedraw)
      loop?.stop()
      unsubscribeResize()
      offError()
      canvasSurface.dispose()
      gpu.dispose()
    },
  }
}
