import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchToken } from '../lib/api'

interface GraphicAppProps {
  /** X11 display to stream, e.g. ":99". */
  display?: string
  /** When set, capture only the window matching this WM_CLASS/name. */
  title?: string
  /** "1" forces full-desktop capture instead of the largest window. */
  desktop?: string
  /** Stream frame rate (server caps at 60). */
  fps?: number
}

type ConnState = 'connecting' | 'connected' | 'disconnected'

const DEFAULT_W = 1280
const DEFAULT_H = 720

/**
 * GraphicAppPane — streams a remote X11 display onto a canvas and injects
 * mouse/keyboard input back into it (see graphic_app_plan.md).
 * Server: /ws/graphic (pkg/graphic).
 *
 * Sizing: the pane's pixel size is sent to the server (connect query +
 * "resize" control messages), which sizes the X display to match — so the
 * captured frame fills the tile with no letterbox bands. The canvas adopts
 * each frame's dimensions; CSS object-fit: contain letterboxes only while
 * a resize is still propagating.
 */
export default function GraphicAppPane({ display = ':99', title, desktop, fps }: GraphicAppProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<ConnState>('connecting')
  const [statusMsg, setStatusMsg] = useState('')

  // ── Frame rendering (latest-wins decode, frame-sized canvas) ─
  const decodeBusy = useRef(false)
  const pendingFrame = useRef<Blob | null>(null)
  const drawFrame = useCallback(async (blob: Blob) => {
    if (decodeBusy.current) {
      pendingFrame.current = blob
      return
    }
    decodeBusy.current = true
    try {
      const bitmap = await createImageBitmap(blob)
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (ctx) {
        // Adopt the frame's dimensions so canvas pixels == display pixels.
        if (canvas && (canvas.width !== bitmap.width || canvas.height !== bitmap.height)) {
          canvas.width = bitmap.width
          canvas.height = bitmap.height
        }
        ctx.drawImage(bitmap, 0, 0)
      }
      bitmap.close()
    } finally {
      decodeBusy.current = false
      const next = pendingFrame.current
      pendingFrame.current = null
      if (next) void drawFrame(next)
    }
  }, [])

  // ── Connection (fresh token per attempt, capped retry) ───────
  useEffect(() => {
    let disposed = false
    let retryTimer: number | undefined
    let attempt = 0

    const paneSize = () => {
      const rect = wrapRef.current?.getBoundingClientRect()
      return {
        w: rect ? Math.round(rect.width) : DEFAULT_W,
        h: rect ? Math.round(rect.height) : DEFAULT_H,
      }
    }

    const connect = async () => {
      if (disposed) return
      setStatus('connecting')
      try {
        const token = await fetchToken()
        if (disposed) return

        const { w, h } = paneSize()
        const params = new URLSearchParams({ display, token, w: String(w), h: String(h) })
        if (title) params.set('title', title)
        if (desktop) params.set('desktop', desktop)
        if (fps && fps !== 30) params.set('fps', String(fps))
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws/graphic?${params}`)
        ws.binaryType = 'blob'
        wsRef.current = ws

        ws.onopen = () => {
          attempt = 0
          setStatus('connected')
        }
        ws.onmessage = (ev) => {
          if (ev.data instanceof Blob) void drawFrame(ev.data)
        }
        ws.onclose = (ev) => {
          if (disposed) return
          setStatus('disconnected')
          setStatusMsg(ev.reason || 'Connection closed')
          // Cap retries at ~5s; the server sends a reason on failure.
          attempt = Math.min(attempt + 1, 5)
          retryTimer = window.setTimeout(connect, attempt * 1000)
        }
        ws.onerror = () => {
          if (disposed) return
          setStatus('disconnected')
        }
      } catch {
        if (disposed) return
        setStatus('disconnected')
        setStatusMsg('Auth failed')
        attempt = Math.min(attempt + 1, 5)
        retryTimer = window.setTimeout(connect, attempt * 1000)
      }
    }

    void connect()
    return () => {
      disposed = true
      if (retryTimer) window.clearTimeout(retryTimer)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [display, title, desktop, fps, drawFrame])

  // ── Pane resize → ask the server to resize the X display ─────
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return

    let timer: number | undefined
    let lastSent = { w: 0, h: 0 }
    const ro = new ResizeObserver(() => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const rect = el.getBoundingClientRect()
        const w = Math.round(rect.width)
        const h = Math.round(rect.height)
        if (w < 50 || h < 50) return
        if (w === lastSent.w && h === lastSent.h) return
        lastSent = { w, h }
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'resize', w, h }))
        }
      }, 300)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (timer) window.clearTimeout(timer)
    }
  }, [])

  // ── Input ────────────────────────────────────────────────────
  const getCoords = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    // object-fit: contain renders the frame at uniform scale, centered
    // with letterbox bars. Compute the actual rendered frame position.
    const scaleX = rect.width / canvas.width
    const scaleY = rect.height / canvas.height
    const scale = Math.min(scaleX, scaleY)
    const frameW = canvas.width * scale
    const frameH = canvas.height * scale
    const offsetX = (rect.width - frameW) / 2
    const offsetY = (rect.height - frameH) / 2
    const px = (e.clientX - rect.left - offsetX) / scale
    const py = (e.clientY - rect.top - offsetY) / scale
    return {
      x: Math.min(Math.max(Math.round(px), 0), canvas.width - 1),
      y: Math.min(Math.max(Math.round(py), 0), canvas.height - 1),
    }
  }, [])

  const send = useCallback((event: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(event))
    }
  }, [])

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getCoords(e)
    send({ type: 'mousemove', x, y })
  }, [getCoords, send])

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getCoords(e)
    // Browser buttons 0/1/2 → X11 buttons 1/2/3
    send({ type: 'mousedown', x, y, button: e.button + 1 })
  }, [getCoords, send])

  const onMouseUp = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getCoords(e)
    send({ type: 'mouseup', x, y, button: e.button + 1 })
  }, [getCoords, send])

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLCanvasElement>) => {
    // Keys the browser would otherwise consume (scrolling, focus nav).
    if (['Space', 'Tab', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault()
    }
    send({
      type: 'keydown',
      key: e.key,
      ctrl: e.ctrlKey,
      alt: e.altKey,
      meta: e.metaKey,
      shift: e.shiftKey,
    })
  }, [send])

  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    const { x, y } = getCoords(e)
    send({ type: 'wheel', x, y, dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) })
  }, [getCoords, send])

  return (
    <div ref={wrapRef} className="relative h-screen w-screen overflow-hidden bg-black">
      <canvas
        ref={canvasRef}
        width={DEFAULT_W}
        height={DEFAULT_H}
        className="h-full w-full select-none"
        style={{ objectFit: 'contain', background: '#000' }}
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={onKeyDown}
        onWheel={onWheel}
        tabIndex={0}
      />
      {status !== 'connected' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/70 backdrop-blur-sm">
          {status === 'connecting' ? (
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
          ) : (
            <svg className="h-8 w-8 text-white/25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4" />
              <path d="M12 16h.01" />
            </svg>
          )}
          <p className="max-w-xs text-center text-[11px] text-white/50">
            {status === 'disconnected' && statusMsg ? statusMsg : status === 'connecting' ? 'Connecting…' : 'Disconnected'}
          </p>
        </div>
      )}
    </div>
  )
}
