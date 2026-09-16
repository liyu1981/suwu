import { init, surface } from 'vgpu'
import type { Gpu, Surface } from 'vgpu'
import { installStirInput, type StirInput } from './pointer-input'
import {
  createFluid,
  prepareFluid,
  renderFluid,
  resizeFluid,
  stepFluid,
  type Fluid,
} from './simulation'
import type { BackgroundContext, BackgroundHandle } from '../../types'

const FIXED_STEP = 1 / 60
// Under reduced motion we settle the field, then show one static frame.
const SETTLE_STEPS = 180

interface FixedStep {
  steps: number
  accumulator: number
}

function fixedStepCount(accumulator: number, elapsed: number): FixedStep {
  let next = accumulator + Math.min(elapsed, 1 / 30)
  let steps = 0
  while (next >= FIXED_STEP && steps < 2) {
    next -= FIXED_STEP
    steps++
  }
  return { steps, accumulator: steps === 2 ? 0 : next }
}

/**
 * Interactive Fluid (GPU only) — a GPU fluid solver driven by the pointer.
 *
 * Ported from the vgpu "Interactive Fluid" example. It has no CPU backend: on a
 * browser without WebGPU the selector renders nothing.
 */
export async function startInteractiveFluid(ctx: BackgroundContext): Promise<BackgroundHandle> {
  const gpu: Gpu = await init({ powerPreference: 'low-power' })

  let disposed = false
  let input: StirInput | undefined
  let fluid!: Fluid
  let canvasSurface!: Surface
  let animationFrame = 0
  let accumulator = 0
  let previous = 0

  const teardown = (): void => {
    if (disposed) return
    disposed = true
    if (animationFrame) cancelAnimationFrame(animationFrame)
    input?.dispose()
    gpu.dispose()
  }

  try {
    canvasSurface = surface(gpu, ctx.canvas, { dpr: ctx.dpr })
    fluid = createFluid(gpu)
    if (!ctx.reducedMotion) input = installStirInput(ctx.canvas)
    await prepareFluid(fluid, canvasSurface)
  } catch (error) {
    teardown()
    throw error
  }

  const fail = (error: unknown): void => {
    if (disposed) return
    console.warn('[interactive-fluid] runtime error', error)
    teardown()
    ctx.onFatal(error)
  }

  const unsubscribeResize = canvasSurface.onResize(() => {
    if (disposed || !fluid || !canvasSurface) return
    try {
      resizeFluid(fluid, canvasSurface)
      if (ctx.reducedMotion) {
        cancelAnimationFrame(animationFrame)
        animationFrame = requestAnimationFrame(() => {
          if (!disposed && fluid && canvasSurface) renderFluid(fluid, canvasSurface)
        })
      }
    } catch (error) {
      fail(error)
    }
  })

  const tick = (now: number): void => {
    if (disposed) return
    if (!document.hidden && fluid && canvasSurface) {
      try {
        const fixed = fixedStepCount(accumulator, (now - previous) / 1000)
        accumulator = fixed.accumulator
        for (let i = 0; i < fixed.steps; i++) {
          stepFluid(fluid, input)
        }
        renderFluid(fluid, canvasSurface)
      } catch (error) {
        fail(error)
        return
      }
    }
    // Always reset the clock while hidden so visibility changes never catch up.
    previous = now
    animationFrame = requestAnimationFrame(tick)
  }

  if (ctx.reducedMotion) {
    try {
      for (let i = 0; i < SETTLE_STEPS; i++) {
        stepFluid(fluid)
      }
      renderFluid(fluid, canvasSurface)
    } catch (error) {
      fail(error)
    }
  } else {
    previous = performance.now()
    animationFrame = requestAnimationFrame(tick)
  }

  return {
    backend: 'gpu',
    dispose() {
      unsubscribeResize()
      teardown()
    },
  }
}
