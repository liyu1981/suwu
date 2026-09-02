import { useEffect, useRef } from 'react'
import type { Terminal } from '@xterm/xterm'

const BELL_FREQ_HZ = 800
const BELL_DURATION_MS = 100

/**
 * Subscribes to xterm.js `onBell` events and provides audio + visual feedback.
 *
 * - **Sound**: plays a short sine-wave beep via the Web Audio API (no files).
 * - **Visual**: adds a `bell-flash` class to the container element, which a
 *   CSS keyframe animation turns into a brief white overlay that fades out.
 *
 * Respects `prefers-reduced-motion` — the flash is skipped (sound still plays)
 * when the user has requested reduced motion.
 */
export function useBell(term: Terminal | null, containerRef: React.RefObject<HTMLDivElement | null>) {
  const ctxRef = useRef<AudioContext | null>(null)

  useEffect(() => {
    if (!term) return

    const playBeep = () => {
      try {
        if (!ctxRef.current) ctxRef.current = new AudioContext()
        const ctx = ctxRef.current
        if (ctx.state === 'suspended') ctx.resume()

        const osc = ctx.createOscillator()
        const gain = ctx.createGain()

        osc.type = 'sine'
        osc.frequency.value = BELL_FREQ_HZ

        // Quick fade-out to avoid a click at the end.
        const now = ctx.currentTime
        const dur = BELL_DURATION_MS / 1000
        gain.gain.setValueAtTime(0.3, now)
        gain.gain.exponentialRampToValueAtTime(0.001, now + dur)

        osc.connect(gain).connect(ctx.destination)
        osc.start(now)
        osc.stop(now + dur)
      } catch {
        // AudioContext may be unavailable (headless, permissions, etc.)
      }
    }

    const flash = () => {
      const el = containerRef.current
      if (!el) return
      // Skip visual flash when the user prefers reduced motion.
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      el.classList.remove('bell-flash')
      // Force a reflow so removing + re-adding the class re-triggers the
      // animation even on rapid consecutive BELs.
      void el.offsetWidth
      el.classList.add('bell-flash')
    }

    const disposable = term.onBell(() => {
      playBeep()
      flash()
    })

    return () => {
      disposable.dispose()
      ctxRef.current?.close()
      ctxRef.current = null
    }
  }, [term, containerRef])
}
