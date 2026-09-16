export interface StirInput {
  active: boolean
  from: [number, number]
  to: [number, number]
  velocity: [number, number]
  consumeStep(): void
  dispose(): void
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

/**
 * Tracks the pointer to "stir" the fluid. Listeners live on the window because
 * the background canvas sits behind the app shell (`pointer-events: none`), so
 * moving anywhere over the page feeds the simulation. Listening is passive —
 * it never consumes events, so the UI keeps working.
 */
export function installStirInput(canvas: HTMLCanvasElement): StirInput {
  let activePointer: number | undefined
  let from: [number, number] = [0.5, 0.5]
  let to: [number, number] = [0.5, 0.5]
  let velocity: [number, number] = [0, 0]
  let lastTime = 0
  let decay = 0

  const point = (event: PointerEvent): [number, number] => {
    const rect = canvas.getBoundingClientRect()
    return [
      clamp01((event.clientX - rect.left) / Math.max(1, rect.width)),
      clamp01(1 - (event.clientY - rect.top) / Math.max(1, rect.height)),
    ]
  }

  const down = (event: PointerEvent) => {
    if (!event.isPrimary || activePointer !== undefined) return
    activePointer = event.pointerId
    from = to = point(event)
    lastTime = event.timeStamp
    velocity = [0, 0]
    decay = 2
  }

  const move = (event: PointerEvent) => {
    if (!event.isPrimary) return
    const next = point(event)
    if (lastTime === 0) {
      from = to = next
      lastTime = event.timeStamp
      return
    }
    const dt = Math.max(0.004, Math.min(0.05, (event.timeStamp - lastTime) / 1000))
    from = to
    to = next
    velocity = [
      Math.max(-2.5, Math.min(2.5, (to[0] - from[0]) / dt)),
      Math.max(-2.5, Math.min(2.5, (to[1] - from[1]) / dt)),
    ]
    lastTime = event.timeStamp
    decay = 2
  }

  const up = (event: PointerEvent) => {
    if (!event.isPrimary || event.pointerId !== activePointer) return
    activePointer = undefined
    decay = 2
  }

  const leave = () => {
    if (activePointer === undefined) {
      lastTime = 0
      decay = 0
    }
  }

  window.addEventListener('pointerdown', down)
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('pointercancel', up)
  window.addEventListener('blur', leave)

  return {
    get active() {
      return activePointer !== undefined || decay > 0
    },
    get from() {
      return from
    },
    get to() {
      return to
    },
    get velocity() {
      return velocity
    },
    consumeStep() {
      from = to
      if (activePointer === undefined && decay > 0) {
        velocity = [velocity[0] * 0.45, velocity[1] * 0.45]
        decay--
      }
    },
    dispose() {
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('blur', leave)
      activePointer = undefined
    },
  }
}
