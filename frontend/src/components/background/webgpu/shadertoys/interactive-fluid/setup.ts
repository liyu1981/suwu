import { registerBackground } from '../../../registry';
import { WEBGPU_ENGINE } from '../../../constants';
import type { BackgroundContext, BackgroundHandle } from '../../../types';
import type {
  Compute,
  Effect,
  Frame,
  Gpu,
  PingPongStorage,
  ShaderSource,
  StorageBuffer,
  Target,
} from 'vgpu';
import type { GpuScene } from '../../webgpu-render-engine';

const FIXED_STEP = 1 / 60;
// Under reduced motion we settle the field, then show one static frame.
const SETTLE_STEPS = 180;

const GRID_SIZE = [128, 72] as const;
const DYE_SIZE = [GRID_SIZE[0] * 4, GRID_SIZE[1] * 4] as const;
const CELLS = GRID_SIZE[0] * GRID_SIZE[1];
const DYE_CELLS = DYE_SIZE[0] * DYE_SIZE[1];

// ── Pointer input ───────────────────────────────────────────────────────────

interface StirInput {
  active: boolean;
  from: [number, number];
  to: [number, number];
  velocity: [number, number];
  consumeStep(): void;
  dispose(): void;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Tracks the pointer to "stir" the fluid. Listeners live on the window because
 * the background canvas sits behind the app shell (`pointer-events: none`), so
 * moving anywhere over the page feeds the simulation. Listening is passive —
 * it never consumes events, so the UI keeps working.
 */
function installStirInput(canvas: HTMLCanvasElement): StirInput {
  let activePointer: number | undefined;
  let from: [number, number] = [0.5, 0.5];
  let to: [number, number] = [0.5, 0.5];
  let velocity: [number, number] = [0, 0];
  let lastTime = 0;
  let decay = 0;

  const point = (event: PointerEvent): [number, number] => {
    const rect = canvas.getBoundingClientRect();
    return [
      clamp01((event.clientX - rect.left) / Math.max(1, rect.width)),
      clamp01(1 - (event.clientY - rect.top) / Math.max(1, rect.height)),
    ];
  };

  const down = (event: PointerEvent) => {
    if (!event.isPrimary || activePointer !== undefined) return;
    activePointer = event.pointerId;
    from = to = point(event);
    lastTime = event.timeStamp;
    velocity = [0, 0];
    decay = 2;
  };

  const move = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    const next = point(event);
    if (lastTime === 0) {
      from = to = next;
      lastTime = event.timeStamp;
      return;
    }
    const dt = Math.max(0.004, Math.min(0.05, (event.timeStamp - lastTime) / 1000));
    from = to;
    to = next;
    velocity = [
      Math.max(-2.5, Math.min(2.5, (to[0] - from[0]) / dt)),
      Math.max(-2.5, Math.min(2.5, (to[1] - from[1]) / dt)),
    ];
    lastTime = event.timeStamp;
    decay = 2;
  };

  const up = (event: PointerEvent) => {
    if (!event.isPrimary || event.pointerId !== activePointer) return;
    activePointer = undefined;
    decay = 2;
  };

  const leave = () => {
    if (activePointer === undefined) {
      lastTime = 0;
      decay = 0;
    }
  };

  window.addEventListener('pointerdown', down);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  window.addEventListener('blur', leave);

  return {
    get active() {
      return activePointer !== undefined || decay > 0;
    },
    get from() {
      return from;
    },
    get to() {
      return to;
    },
    get velocity() {
      return velocity;
    },
    consumeStep() {
      from = to;
      if (activePointer === undefined && decay > 0) {
        velocity = [velocity[0] * 0.45, velocity[1] * 0.45];
        decay--;
      }
    },
    dispose() {
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', leave);
      activePointer = undefined;
    },
  };
}

// ── Simulation ──────────────────────────────────────────────────────────────

interface FluidPasses {
  advectVelocity: Compute;
  curl: Compute;
  vorticity: Compute;
  divergence: Compute;
  pressure: Compute;
  project: Compute;
  advectDye: Compute;
  display: Effect;
}

interface Fluid {
  gpu: Gpu;
  velocity: PingPongStorage;
  dye: PingPongStorage;
  pressure: PingPongStorage;
  divergence: StorageBuffer;
  curl: StorageBuffer;
  passes: FluidPasses;
  step: number;
  lastInputStep: number;
}

function destroyBuffer(buffer: object) {
  const disposable = buffer as { destroy(): void };
  disposable.destroy();
}

interface FixedStep {
  steps: number;
  accumulator: number;
}

function fixedStepCount(accumulator: number, elapsed: number): FixedStep {
  let next = accumulator + Math.min(elapsed, 1 / 30);
  let steps = 0;
  while (next >= FIXED_STEP && steps < 2) {
    next -= FIXED_STEP;
    steps++;
  }
  return { steps, accumulator: steps === 2 ? 0 : next };
}

async function prepareFluid(fluid: Fluid, output: Target): Promise<void> {
  resizeFluid(fluid, output);
  await fluid.passes.display.compile({ colors: [output.format] });
}

function resizeFluid(fluid: Fluid, output: Target): void {
  fluid.passes.display.set({ config: { output_size: output.size } });
}

function stepFluid(fluid: Fluid, input?: StirInput): void {
  if (input?.active) fluid.lastInputStep = fluid.step;
  const dynamic = inputUniforms(fluid, input);
  const p = fluid.passes;

  p.advectVelocity
    .set({
      input: dynamic,
      src: fluid.velocity.read,
      dst: fluid.velocity.write,
    })
    .dispatch(16, 9);
  fluid.velocity.swap();

  // Confinement restores the small rotating details lost by semi-Lagrangian advection.
  p.curl.set({ velocity: fluid.velocity.read, curl: fluid.curl }).dispatch(16, 9);
  p.vorticity
    .set({
      src: fluid.velocity.read,
      curl: fluid.curl,
      dst: fluid.velocity.write,
    })
    .dispatch(16, 9);
  fluid.velocity.swap();

  p.divergence.set({ velocity: fluid.velocity.read, divergence: fluid.divergence }).dispatch(16, 9);
  for (let i = 0; i < 3; i++) {
    p.pressure
      .set({
        params: { decay: i === 0 ? 0.8 : 1 },
        src: fluid.pressure.read,
        divergence: fluid.divergence,
        dst: fluid.pressure.write,
      })
      .dispatch(16, 9);
    fluid.pressure.swap();
  }

  p.project
    .set({
      src: fluid.velocity.read,
      pressure: fluid.pressure.read,
      dst: fluid.velocity.write,
    })
    .dispatch(16, 9);
  fluid.velocity.swap();

  p.advectDye
    .set({
      input: dynamic,
      src: fluid.dye.read,
      velocity: fluid.velocity.read,
      dst: fluid.dye.write,
    })
    .dispatch(64, 36);
  fluid.dye.swap();
  fluid.step++;
  input?.consumeStep();
}

function renderFluid(fluid: Fluid, output: Target, current: Frame): void {
  fluid.passes.display.set({ dye: fluid.dye.read });
  current.pass(output, fluid.passes.display);
}

function inputUniforms(fluid: Fluid, input?: StirInput) {
  const time = fluid.step / 60;
  const [a, b] = idleEmitters(fluid.step);
  const sinceInput = fluid.step - fluid.lastInputStep;
  const idle = sinceInput < 90 ? 0.15 : 0.15 + 0.85 * Math.min(1, (sinceInput - 90) / 60);
  const ramp = Math.min(1, (fluid.step + 1) / 24);
  let pointerVelocity = input?.velocity ?? ([0, 0] as [number, number]);
  if (input?.active && Math.hypot(...pointerVelocity) < 0.02) {
    pointerVelocity = [0.16 * Math.cos(time * 5), 0.16 * Math.sin(time * 5)];
  }
  const speed = Math.hypot(...pointerVelocity);
  const direction =
    speed > 1e-4 ? [pointerVelocity[0] / speed, pointerVelocity[1] / speed] : [0, 0];
  return {
    step: fluid.step,
    pointer_active: input?.active ? 1 : 0,
    pointer_from: input?.from ?? [0.5, 0.5],
    pointer_to: input?.to ?? [0.5, 0.5],
    pointer_velocity: pointerVelocity,
    // Like the reference, splat color comes from movement direction, with blue held high.
    pointer_color: [0.5 + 0.5 * direction[0]!, 0.5 + 0.5 * direction[1]!, 1, 1],
    idle_a: [...a, ramp * idle, 0.006],
    idle_b: [...b, ramp * idle, 0.0055],
  };
}

function idleEmitters(step: number): [[number, number], [number, number]] {
  const t = step / 60;
  return [
    [0.5 + 0.28 * Math.sin(0.73 * t), 0.5 + 0.22 * Math.sin(1.09 * t + 0.4)],
    [0.5 + 0.26 * Math.sin(0.61 * t + Math.PI), 0.5 + 0.24 * Math.sin(0.97 * t + 2.1)],
  ];
}

/**
 * Interactive Fluid (GPU only) — a GPU fluid solver driven by the pointer,
 * ported from the vgpu "Interactive Fluid" example. The engine owns the frame
 * loop; this scene turns each tick's elapsed time into 0–2 fixed simulation
 * steps (stable regardless of the shared `fps`), then presents the dye field.
 *
 * The engine, vgpu and the WGSL are imported lazily so the metadata below can
 * be registered eagerly without pulling them into the initial bundle.
 */
async function start(
  ctx: BackgroundContext,
  params?: Record<string, unknown>,
): Promise<BackgroundHandle> {
  const [
    { startGpuBackground },
    { compute, effect, frame, pingPongStorage, storage },
    { default: advectVelocityWgsl },
    { default: curlWgsl },
    { default: vorticityWgsl },
    { default: divergenceWgsl },
    { default: pressureWgsl },
    { default: projectWgsl },
    { default: advectDyeWgsl },
    { default: displayWgsl },
  ] = await Promise.all([
    import('../../webgpu-render-engine'),
    import('vgpu'),
    import('./shaders/advect-velocity.wgsl'),
    import('./shaders/curl.wgsl'),
    import('./shaders/vorticity.wgsl'),
    import('./shaders/divergence.wgsl'),
    import('./shaders/pressure.wgsl'),
    import('./shaders/project.wgsl'),
    import('./shaders/advect-dye.wgsl'),
    import('./shaders/display.wgsl'),
  ]);

  const createPasses = (gpu: Gpu): FluidPasses => {
    const withGrid = (shader: ShaderSource) =>
      compute(gpu, shader, {
        set: { grid: { size: GRID_SIZE, dye_size: DYE_SIZE } },
      });
    return {
      advectVelocity: withGrid(advectVelocityWgsl),
      curl: withGrid(curlWgsl),
      vorticity: withGrid(vorticityWgsl),
      divergence: withGrid(divergenceWgsl),
      pressure: withGrid(pressureWgsl),
      project: withGrid(projectWgsl),
      advectDye: withGrid(advectDyeWgsl),
      display: effect(gpu, displayWgsl),
    };
  };

  const createFluid = (gpu: Gpu): Fluid => {
    const allocated: object[] = [];
    try {
      const velocity = pingPongStorage(gpu, CELLS * 8);
      allocated.push(velocity.read, velocity.write);
      const dye = pingPongStorage(gpu, DYE_CELLS * 16);
      allocated.push(dye.read, dye.write);
      const pressure = pingPongStorage(gpu, CELLS * 4);
      allocated.push(pressure.read, pressure.write);
      const divergence = storage(gpu, CELLS * 4, 'read-write');
      allocated.push(divergence);
      const curl = storage(gpu, CELLS * 4, 'read-write');
      allocated.push(curl);
      const passes = createPasses(gpu);
      return {
        gpu,
        velocity,
        dye,
        pressure,
        divergence,
        curl,
        passes,
        step: 0,
        lastInputStep: -1000,
      };
    } catch (error) {
      for (const buffer of allocated) {
        destroyBuffer(buffer);
      }
      throw error;
    }
  };

  return startGpuBackground(
    'interactive-fluid',
    (init) => {
      let fluid: Fluid | undefined;
      let input: StirInput | undefined;
      let accumulator = 0;
      let previous = performance.now();
      let failed = false;

      const present = (current: Frame): void => {
        if (fluid) renderFluid(fluid, init.surface, current);
      };

      const guard = (body: (field: Fluid) => void): void => {
        if (failed || !fluid) return;
        try {
          body(fluid);
        } catch (error) {
          failed = true;
          console.warn('[interactive-fluid] runtime error', error);
          ctx.onFatal(error);
        }
      };

      const scene: GpuScene = {
        async prepare() {
          fluid = createFluid(init.gpu);
          if (!ctx.reducedMotion)
            input = installStirInput(init.surface.canvas as HTMLCanvasElement);
          await prepareFluid(fluid, init.surface);
        },
        resize() {
          if (fluid) resizeFluid(fluid, init.surface);
        },
        render(current) {
          guard((field) => {
            const now = performance.now();
            const fixed = fixedStepCount(accumulator, (now - previous) / 1000);
            accumulator = fixed.accumulator;
            previous = now;
            for (let i = 0; i < fixed.steps; i++) stepFluid(field, input);
            present(current);
          });
        },
        settle() {
          guard((field) => {
            for (let i = 0; i < SETTLE_STEPS; i++) stepFluid(field);
            frame(init.gpu, present);
          });
        },
        present() {
          guard(() => frame(init.gpu, present));
        },
        destroy() {
          input?.dispose();
          input = undefined;
        },
      };
      return scene;
    },
    ctx,
    params,
  );
}

registerBackground({
  id: 'interactive-fluid',
  label: 'Interactive Fluid',
  engine: WEBGPU_ENGINE,
  credit: {
    author: 'vgpu (Interactive Fluid example)',
    url: 'https://vgpu.sh',
  },
  gpu: async () => ({ start }),
});
