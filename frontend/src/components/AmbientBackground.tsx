import { useEffect, useRef } from 'react'
import { clamp } from '../lib/utils'

const HUES = [200, 260, 320, 170, 30, 355]

interface Blob {
  rx: number
  ry: number
  radius: number
  hue: number
  sat: number
  light: number
  alpha: number
  vx: number
  vy: number
  ampX: number
  ampY: number
  phase: number
  freq: number
}

interface Palette {
  sat: number
  light: number
  alpha: number
  count: number
}

const LIGHT: Palette = { sat: 95, light: 74, alpha: 0.45, count: 12 }
const DARK: Palette = { sat: 95, light: 60, alpha: 0.55, count: 12 }

function isDark(): boolean {
  return document.documentElement.classList.contains('dark')
}

function paletteFor(dark: boolean, reducedTransparency: boolean): Palette {
  const base = dark ? DARK : LIGHT
  return reducedTransparency ? { ...base, alpha: base.alpha * 0.55 } : base
}

function makeBlobs(palette: Palette): Blob[] {
  return Array.from({ length: palette.count }, () => {
    const hue = HUES[Math.floor(Math.random() * HUES.length)] + (Math.random() * 24 - 12)

    return {
      rx: Math.random(),
      ry: Math.random(),
      radius: 0.07 + Math.random() * 0.18,
      hue: ((hue % 360) + 360) % 360,
      sat: clamp(palette.sat + (Math.random() * 12 - 6), 0, 100),
      light: clamp(palette.light + (Math.random() * 10 - 5), 0, 100),
      alpha: Math.max(0.08, palette.alpha + (Math.random() * 0.12 - 0.06)),
      vx: (Math.random() * 2 - 1) * 16,
      vy: (Math.random() * 2 - 1) * 16,
      ampX: 20 + Math.random() * 50,
      ampY: 20 + Math.random() * 50,
      phase: Math.random() * Math.PI * 2,
      freq: 0.04 + Math.random() * 0.1,
    }
  })
}

function wrap(value: number, min: number, max: number): number {
  const range = max - min
  return ((((value - min) % range) + range) % range) + min
}

export function AmbientBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const reducedTransparency = window.matchMedia('(prefers-reduced-transparency: reduce)').matches
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    let width = 0
    let height = 0
    let blobs = makeBlobs(paletteFor(isDark(), reducedTransparency))
    let raf = 0

    const render = (t: number): void => {
      ctx.clearRect(0, 0, width, height)
      ctx.globalCompositeOperation = 'lighter'

      const base = Math.min(width, height)

      for (const blob of blobs) {
        const x = wrap(
          blob.rx * width + blob.ampX * Math.sin(t * blob.freq + blob.phase) + blob.vx * t,
          -200,
          width + 200,
        )
        const y = wrap(
          blob.ry * height +
            blob.ampY * Math.cos(t * blob.freq * 0.8 + blob.phase * 1.3) +
            blob.vy * t,
          -200,
          height + 200,
        )
        const radius = blob.radius * base * (1 + 0.08 * Math.sin(t * 0.3 + blob.phase))
        const hue = (blob.hue + t * 1.2) % 360
        const core = `hsla(${hue} ${blob.sat}% ${blob.light}% / ${blob.alpha})`
        const edge = `hsla(${hue} ${blob.sat}% ${blob.light}% / 0)`

        const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius)
        gradient.addColorStop(0, core)
        gradient.addColorStop(0.6, core)
        gradient.addColorStop(1, edge)

        ctx.fillStyle = gradient
        ctx.beginPath()
        ctx.arc(x, y, radius, 0, Math.PI * 2)
        ctx.fill()
      }

      ctx.globalCompositeOperation = 'source-over'
    }

    const resize = (): void => {
      width = window.innerWidth
      height = window.innerHeight

      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      render(performance.now() / 1000)
    }

    const frame = (t: number): void => {
      render(t / 1000)
      if (!reducedMotion) {
        raf = requestAnimationFrame(frame)
      }
    }

    const themeObserver = new MutationObserver(() => {
      blobs = makeBlobs(paletteFor(isDark(), reducedTransparency))
      render(performance.now() / 1000)
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })

    window.addEventListener('resize', resize)

    resize()
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      themeObserver.disconnect()
      window.removeEventListener('resize', resize)
    }
  }, [])

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none fixed inset-0 z-0" />
}
