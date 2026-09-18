import { frame } from 'vgpu'
import type { Frame } from 'vgpu'
import { startGpuBackground } from '../../webgpu-render-engine'
import type { GpuScene } from '../../webgpu-render-engine'
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
 * Ported from the vgpu "Interactive Fluid" example. The engine owns the frame
 * loop; this scene turns each tick's elapsed time into 0–2 fixed simulation
 * steps (so the solver is stable regardless of the shared `fps`), then presents
 * the dye field. On a browser without WebGPU the selector renders nothing.
 */
export function startInteractiveFluid(
  ctx: BackgroundContext,
  params?: Record<string, unknown>,
): Promise<BackgroundHandle> {
  return startGpuBackground(
    'interactive-fluid',
    (init) => {
      let fluid: Fluid | undefined
      let input: StirInput | undefined
      let accumulator = 0
      let previous = performance.now()
      let failed = false

      const present = (current: Frame): void => {
        if (fluid) renderFluid(fluid, init.surface, current)
      }

      const guard = (body: (fluid: Fluid) => void): void => {
        if (failed || !fluid) return
        try {
          body(fluid)
        } catch (error) {
          failed = true
          console.warn('[interactive-fluid] runtime error', error)
          ctx.onFatal(error)
        }
      }

      const scene: GpuScene = {
        async prepare() {
          fluid = createFluid(init.gpu)
          if (!ctx.reducedMotion) input = installStirInput(init.surface.canvas as HTMLCanvasElement)
          await prepareFluid(fluid, init.surface)
        },
        resize() {
          if (fluid) resizeFluid(fluid, init.surface)
        },
        render(current) {
          guard((field) => {
            const now = performance.now()
            const fixed = fixedStepCount(accumulator, (now - previous) / 1000)
            accumulator = fixed.accumulator
            previous = now
            for (let i = 0; i < fixed.steps; i++) stepFluid(field, input)
            present(current)
          })
        },
        settle() {
          guard((field) => {
            for (let i = 0; i < SETTLE_STEPS; i++) stepFluid(field)
            frame(init.gpu, present)
          })
        },
        present() {
          guard(() => frame(init.gpu, present))
        },
        destroy() {
          input?.dispose()
          input = undefined
        },
      }
      return scene
    },
    ctx,
    params,
  )
}
