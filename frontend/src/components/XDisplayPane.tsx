import { useCallback, useEffect, useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import { fetchToken } from '../lib/api'
import { xdisplayFpsAtom } from '../store/zoom'

interface XDisplayProps {
  /** X11 display number to stream, e.g. "99" for :99. */
  display?: string
  /** When set, capture only the window matching this WM_CLASS/name. */
  title?: string
  /** "1" forces full-desktop capture instead of the largest window. */
  desktop?: string
  /** Stream frame rate (server caps at 60). */
  fps?: number
}

type ConnState = 'connecting' | 'connected' | 'disconnected'

type DepComponent = {
  name: string
  description: string
  installed: boolean
}

type DepError = {
  type: 'missing_deps'
  components: DepComponent[]
  install: Record<string, string>
}

type DisplayInUseError = {
  type: 'display_in_use'
  display: string
  connected: string
}

const DEFAULT_W = 1280
const DEFAULT_H = 720

const distroLabels: Record<string, string> = {
  debian: 'Ubuntu / Debian',
  redhat: 'Red Hat / CentOS / Fedora',
  arch: 'Arch Linux',
}

/**
 * XDisplayPane — streams a remote X11 display onto a canvas and injects
 * mouse/keyboard input back into it. Shows a header with the display
 * number and connection status.
 */
export default function XDisplayPane({ display = '99', title, desktop, fps: fpsProp }: XDisplayProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasWrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<ConnState>('connecting')
  const [statusMsg, setStatusMsg] = useState('')
  const [depError, setDepError] = useState<DepError | null>(null)
  const [displayInUse, setDisplayInUse] = useState<DisplayInUseError | null>(null)
  const [switchDisplay, setSwitchDisplay] = useState('')
  const fpsSetting = useAtomValue(xdisplayFpsAtom)
  const fps = fpsProp ?? fpsSetting

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

    const paneSize = () => {
      const rect = canvasWrapRef.current?.getBoundingClientRect()
      return {
        w: rect ? Math.round(rect.width) : DEFAULT_W,
        h: rect ? Math.round(rect.height) : DEFAULT_H,
      }
    }

    const connect = async () => {
      if (disposed) return
      setStatus('connecting')
      setDepError(null)
      setDisplayInUse(null)
      try {
        const token = await fetchToken()
        if (disposed) return

        const { w, h } = paneSize()
    const displayParam = display.startsWith(':') ? display : `:${display}`
        const params = new URLSearchParams({ display: displayParam, token, w: String(w), h: String(h) })
        if (title) params.set('title', title)
        if (desktop) params.set('desktop', desktop)
        if (fps && fps !== 30) params.set('fps', String(fps))
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const ws = new WebSocket(`${protocol}//${window.location.host}/ws/xdisplay?${params}`)
        ws.binaryType = 'blob'
        wsRef.current = ws

        ws.onopen = () => {
          setStatus('connected')
        }
        ws.onmessage = (ev) => {
          // Check if this is a structured error message (text, not blob).
          if (typeof ev.data === 'string') {
            try {
              const data = JSON.parse(ev.data)
              if (data.type === 'missing_deps') {
                setDepError(data as DepError)
                setStatusMsg('')
                ws.close()
                return
              }
              if (data.type === 'display_in_use') {
                setDisplayInUse(data as DisplayInUseError)
                setStatusMsg('')
                ws.close()
                return
              }
            } catch {
              // Not JSON — ignore.
            }
            return
          }
          // Binary data = JPEG frame.
          void drawFrame(ev.data)
        }
        ws.onclose = (ev) => {
          if (disposed) return
          setStatus('disconnected')
          setStatusMsg(ev.reason || 'Connection closed')
        }
        ws.onerror = () => {
          if (disposed) return
          setStatus('disconnected')
        }
      } catch {
        if (disposed) return
        setStatus('disconnected')
        setStatusMsg('Auth failed')
      }
    }

    void connect()
    return () => {
      disposed = true
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [display, title, desktop, fps, drawFrame])

  const handleRetry = useCallback(() => {
    // Refresh the iframe to retry once.
    window.location.reload()
  }, [])

  const handleSwitchDisplay = useCallback(() => {
    if (switchDisplay.trim()) {
      // Redirect to same page with new display parameter.
      const url = new URL(window.location.href)
      url.searchParams.set('display', switchDisplay.trim())
      window.location.href = url.toString()
    }
  }, [switchDisplay])

  // ── Pane resize → ask the server to resize the X display ─────
  useEffect(() => {
    const el = canvasWrapRef.current
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
    <div ref={wrapRef} className="relative flex h-full w-full flex-col overflow-hidden bg-black">
      {/* Header bar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.08] bg-white/[0.05] px-3 py-1.5">
        {/* Status indicator */}
        <div className={`h-2 w-2 rounded-full ${
          status === 'connected' ? 'bg-green-500' :
          status === 'connecting' ? 'bg-amber-500 animate-pulse' :
          'bg-red-500'
        }`} />
        {/* Display info + status */}
        <span className="text-[11px] font-semibold tracking-wide text-white/60">
          DISPLAY :{display.replace(/^:/, '')}
        </span>
        <span className="text-[10px] text-white/40">
          {status === 'connected' ? 'Connected' :
           status === 'connecting' ? 'Connecting…' :
           depError ? 'Missing dependencies' :
           displayInUse ? 'Display in use' : statusMsg || 'Disconnected'}
        </span>
      </div>

      {/* Canvas area with margin */}
      <div ref={canvasWrapRef} className="min-h-0 min-w-0 flex-1 p-[0.5rem]">
        <canvas
          ref={canvasRef}
          width={DEFAULT_W}
          height={DEFAULT_H}
          className="h-full w-full select-none rounded bg-black"
          style={{ objectFit: 'contain' }}
          onMouseMove={onMouseMove}
          onMouseDown={onMouseDown}
          onMouseUp={onMouseUp}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={onKeyDown}
          onWheel={onWheel}
          tabIndex={0}
        />
      </div>

      {/* Dependency error overlay */}
      {depError && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="mx-4 max-w-md rounded-xl border border-white/10 bg-gray-900 p-5 shadow-2xl">
            <div className="mb-4 flex items-center gap-2">
              <svg className="h-5 w-5 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 8v4" />
                <path d="M12 16h.01" />
              </svg>
              <h3 className="text-sm font-semibold text-white">X Display Requirements Not Met</h3>
            </div>

            {/* Component status list */}
            <div className="mb-4 rounded-lg border border-white/5 bg-black/30 p-3">
              {depError.components.map((c) => (
                <div key={c.name} className="flex items-center gap-2 py-1">
                  {c.installed ? (
                    <svg className="h-4 w-4 text-green-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  ) : (
                    <svg className="h-4 w-4 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 6L6 18" />
                      <path d="M6 6l12 12" />
                    </svg>
                  )}
                  <span className={`text-xs ${c.installed ? 'text-white/60' : 'text-white/90'}`}>
                    {c.name}
                    <span className="ml-1.5 text-white/40">{c.description}</span>
                  </span>
                </div>
              ))}
            </div>

            {/* Install commands */}
            <div className="mb-4 space-y-2">
              <p className="text-[11px] font-medium text-white/50">Install missing packages:</p>
              {Object.entries(depError.install).map(([distro, cmd]) => (
                <div key={distro} className="rounded-md bg-black/40 px-3 py-2">
                  <p className="mb-1 text-[10px] font-medium text-white/40 capitalize">{distroLabels[distro] ?? distro}</p>
                  <code className="block font-mono text-[11px] text-green-400/90">{cmd}</code>
                </div>
              ))}
            </div>

            {/* Retry button */}
            <button
              type="button"
              onClick={handleRetry}
              className="w-full rounded-lg bg-white/10 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-white/20"
            >
              🔄 Retry
            </button>
          </div>
        </div>
      )}

      {/* Display in use overlay */}
      {displayInUse && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="mx-4 max-w-sm rounded-xl border border-white/10 bg-gray-900 p-5 shadow-2xl">
            <div className="mb-4 flex items-center gap-2">
              <svg className="h-5 w-5 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
              </svg>
              <h3 className="text-sm font-semibold text-white">Display In Use</h3>
            </div>

            <p className="mb-4 text-xs text-white/60">
              Display <span className="font-mono text-white/90">{displayInUse.display}</span> is already connected by another tile.
            </p>

            <div className="mb-4">
              <label className="mb-1.5 block text-[11px] font-medium text-white/50">Switch to display number:</label>
              <div className="flex gap-2">
                <div className="flex flex-1 items-center rounded-lg border border-white/10 bg-black/30 px-2">
                  <span className="text-xs text-white/40">:</span>
                  <input
                    type="number"
                    value={switchDisplay}
                    onChange={(e) => setSwitchDisplay(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSwitchDisplay()}
                    placeholder="99"
                    min={0}
                    max={99}
                    className="w-full bg-transparent px-1 py-2 text-xs text-white outline-none placeholder:text-white/30"
                  />
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleRetry}
                className="flex-1 rounded-lg bg-white/5 px-4 py-2 text-xs font-medium text-white/60 transition-colors hover:bg-white/10 hover:text-white/80"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSwitchDisplay}
                disabled={!switchDisplay.trim()}
                className="flex-1 rounded-lg bg-white/10 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-white/20 disabled:opacity-30"
              >
                Switch
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
