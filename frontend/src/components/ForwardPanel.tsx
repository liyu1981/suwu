import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getCredentials } from '../lib/auth'
import { CommonTileContainer } from './CommonTileContainer'
import { RefreshIcon } from './icons'

interface ForwardStatus {
  id: string
  externalPort: number
  internalHost: string
  internalPort: number
  protocol: string
  status: string
  error?: string
  activeConns: number
  totalConns: number
  startedAt?: string
}

const STATUS_COLORS = {
  running: 'bg-green-500',
  stopped: 'bg-gray-400',
  error: 'bg-red-500',
} as const

const inputClass =
  'rounded bg-black/30 border border-white/10 px-2 py-1 text-xs text-white/80 placeholder-white/30 focus:outline-none focus:ring-1'

const inputValid = 'focus:border-green-500/50 focus:ring-green-500/30'
const inputInvalid = 'border-red-500/50 focus:border-red-500/50 focus:ring-red-500/30'

const btnPrimary =
  'shrink-0 rounded bg-cyan-500/20 px-3 py-1 text-xs font-medium text-cyan-300 transition hover:bg-cyan-500/30 active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed'

const btnDanger =
  'rounded bg-red-500/20 px-2 py-1 text-[10px] text-red-400 transition hover:bg-red-500/30 active:scale-[0.97]'

async function apiFetch(path: string, init?: RequestInit): Promise<unknown> {
  const headers: Record<string, string> = {}
  const creds = getCredentials()
  if (creds) headers['Authorization'] = creds
  if (init?.headers) Object.assign(headers, init.headers)
  const res = await fetch(path, { ...init, headers })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(body || `HTTP ${res.status}`)
  }
  return res.json()
}

function formatUptime(startedAt: string): string {
  const start = new Date(startedAt).getTime()
  const now = Date.now()
  const diff = Math.floor((now - start) / 1000)
  const h = Math.floor(diff / 3600)
  const m = Math.floor((diff % 3600) / 60)
  const s = diff % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function validatePort(value: string, occupied: number[]): { valid: boolean; error?: string } {
  if (value === '') return { valid: true }
  const n = parseInt(value, 10)
  if (isNaN(n)) return { valid: false, error: 'Invalid' }
  if (n < 1024) return { valid: false, error: '< 1024' }
  if (n > 65535) return { valid: false, error: '> 65535' }
  if (occupied.includes(n)) return { valid: false, error: 'Occupied' }
  return { valid: true }
}

function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().trim()
  return h === '' || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0'
}

export default function ForwardPanel() {
  const { t } = useTranslation()
  const [forwards, setForwards] = useState<ForwardStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [extPort, setExtPort] = useState('')
  const [intHost, setIntHost] = useState('localhost')
  const [intPort, setIntPort] = useState('')
  const [protocol, setProtocol] = useState<'tcp' | 'udp'>('tcp')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [serverPorts, setServerPorts] = useState<number[]>([])
  const [intPortOpen, setIntPortOpen] = useState<boolean | null>(null)
  const [extPortCheck, setExtPortCheck] = useState(0)
  const checkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      const data = await apiFetch('/api/forward/status')
      setForwards(Array.isArray(data) ? data : [])
    } catch {
      // silent
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchServerPorts = useCallback(async () => {
    try {
      const data = await apiFetch('/api/forward/server-ports') as { ports: number[] }
      setServerPorts(data.ports ?? [])
    } catch {
      // silent
    }
  }, [])

  useEffect(() => {
    fetchStatus()
    fetchServerPorts()
  }, [fetchStatus, fetchServerPorts])

  useEffect(() => {
    const anyRunning = forwards.some((f) => f.status === 'running')
    if (!anyRunning) return
    const timer = setInterval(() => {
      fetchStatus()
      fetchServerPorts()
    }, 5000)
    return () => clearInterval(timer)
  }, [forwards, fetchStatus, fetchServerPorts])

  // Debounced check for internal port openness
  useEffect(() => {
    if (checkTimerRef.current) {
      clearTimeout(checkTimerRef.current)
    }

    const n = parseInt(intPort, 10)
    if (isNaN(n) || n < 1 || n > 65535 || !isLocalHost(intHost)) {
      setIntPortOpen(null)
      return
    }

    setIntPortOpen(null) // reset while checking
    checkTimerRef.current = setTimeout(() => {
      setIntPortOpen(serverPorts.includes(n))
    }, 300)

    return () => {
      if (checkTimerRef.current) clearTimeout(checkTimerRef.current)
    }
  }, [intPort, intHost, serverPorts])

  // Debounced check for external port occupancy
  useEffect(() => {
    if (checkTimerRef.current) {
      clearTimeout(checkTimerRef.current)
    }

    const n = parseInt(extPort, 10)
    if (isNaN(n) || n < 1024 || n > 65535) {
      return
    }

    checkTimerRef.current = setTimeout(() => {
      // trigger re-render by updating a counter
      setExtPortCheck((c) => c + 1)
    }, 300)

    return () => {
      if (checkTimerRef.current) clearTimeout(checkTimerRef.current)
    }
  }, [extPort, serverPorts])

  const extPortOccupied = parseInt(extPort, 10) > 0 && serverPorts.includes(parseInt(extPort, 10))
  const extPortValidation = validatePort(extPort, serverPorts)
  const intPortValidation = validatePort(intPort, [])
  const canCreate = extPort !== '' && intPort !== '' && extPortValidation.valid && intPortValidation.valid

  const handleCreate = useCallback(async () => {
    const ep = parseInt(extPort, 10)
    const ip = parseInt(intPort, 10)
    if (!canCreate) {
      setError(t('forward.portRequired'))
      return
    }

    setCreating(true)
    setError(null)
    try {
      await apiFetch('/api/forward/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          externalPort: ep,
          internalHost: intHost || 'localhost',
          internalPort: ip,
          protocol,
        }),
      })
      setExtPort('')
      setIntPort('')
      await fetchStatus()
      await fetchServerPorts()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to create')
    } finally {
      setCreating(false)
    }
  }, [extPort, intHost, intPort, protocol, canCreate, t, fetchStatus, fetchServerPorts])

  const handleRemove = useCallback(
    async (id: string) => {
      try {
        await apiFetch('/api/forward/remove', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        })
        await fetchStatus()
        await fetchServerPorts()
      } catch {
        // silent
      }
    },
    [fetchStatus, fetchServerPorts],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && canCreate) {
        handleCreate()
      }
    },
    [handleCreate, canCreate],
  )

  const extPortMsg = extPort !== '' && !extPortValidation.valid ? extPortValidation.error : undefined
  const intPortMsg = intPort !== '' && !intPortValidation.valid ? intPortValidation.error : undefined
  const showIntPortWarning = intPort !== '' && intPortValidation.valid && isLocalHost(intHost) && intPortOpen === false

  return (
    <CommonTileContainer>
      <div className="flex h-full flex-col overflow-hidden rounded-[6px] bg-black/40 text-sm text-white/80">
        {/* Header */}
        <div className="flex shrink-0 items-center border-b border-white/10 bg-black/30 px-3 py-2">
          <span className="text-xs font-medium text-white/60">{t('forward.title')}</span>
          <button
            type="button"
            onClick={fetchServerPorts}
            className="ml-2 grid h-4 w-4 place-items-center rounded text-white/40 transition hover:bg-white/10 hover:text-white/60"
            title={t('forward.refreshPorts')}
          >
            <RefreshIcon />
          </button>
          <div className="flex-1" />
        </div>

        {/* Config row — embedded table-style */}
        <div className="flex shrink-0 items-center gap-1.5 border-b border-white/10 bg-black/20 px-2 py-1.5">
          {/* Protocol toggle */}
          <div className="flex shrink-0 overflow-hidden rounded border border-white/10">
            <button
              type="button"
              onClick={() => setProtocol('tcp')}
              className={`px-1.5 py-0.5 text-[10px] font-medium transition ${
                protocol === 'tcp' ? 'bg-cyan-500/30 text-cyan-300' : 'text-white/40 hover:bg-white/5'
              }`}
            >
              {t('forward.tcp')}
            </button>
            <button
              type="button"
              onClick={() => setProtocol('udp')}
              className={`px-1.5 py-0.5 text-[10px] font-medium transition ${
                protocol === 'udp' ? 'bg-violet-500/30 text-violet-300' : 'text-white/40 hover:bg-white/5'
              }`}
            >
              {t('forward.udp')}
            </button>
          </div>

          {/* External port */}
          <input
            type="number"
            placeholder={t('forward.externalPort')}
            value={extPort}
            onChange={(e) => setExtPort(e.target.value)}
            onKeyDown={handleKeyDown}
            min={1024}
            max={65535}
            className={`${inputClass} ${extPortMsg ? inputInvalid : inputValid} w-20`}
          />

          <span className="text-[10px] text-white/30">→</span>

          {/* Internal host */}
          <input
            type="text"
            placeholder={t('forward.internalHost')}
            value={intHost}
            onChange={(e) => setIntHost(e.target.value)}
            onKeyDown={handleKeyDown}
            className={`${inputClass} ${inputValid} w-24`}
          />

          {/* Internal port */}
          <input
            type="number"
            placeholder={t('forward.internalPort')}
            value={intPort}
            onChange={(e) => setIntPort(e.target.value)}
            onKeyDown={handleKeyDown}
            min={1}
            max={65535}
            className={`${inputClass} ${intPortMsg ? inputInvalid : inputValid} w-20`}
          />

          {/* Add & Start */}
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating || !canCreate}
            className={btnPrimary}
          >
            {creating ? '...' : t('forward.addAndStart')}
          </button>
        </div>

        {/* Validation messages */}
        {(extPortMsg || intPortMsg || showIntPortWarning || error) && (
          <div className="flex shrink-0 flex-wrap gap-3 border-b border-white/10 bg-black/20 px-3 py-1">
            {extPortMsg && <span className="text-[10px] text-red-400">{t('forward.portOccupied')}</span>}
            {intPortMsg && <span className="text-[10px] text-red-400">Int: {intPortMsg}</span>}
            {showIntPortWarning && (
              <span className="text-[10px] text-amber-400">
                ⚠ Port {intPort} is not open on {intHost || 'localhost'}
              </span>
            )}
            {error && <span className="text-[10px] text-red-400">{error}</span>}
          </div>
        )}

        {/* Active mappings list */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-12 text-xs text-white/30">Loading...</div>
          )}
          {!loading && forwards.length === 0 && (
            <div className="flex items-center justify-center py-12 text-xs text-white/30">
              {t('forward.noMappings')}
            </div>
          )}
          {forwards.map((f) => (
            <div
              key={f.id}
              className="flex items-center gap-3 border-b border-white/5 px-3 py-2 transition hover:bg-white/5"
            >
              {/* Status dot */}
              <div className={`h-2 w-2 shrink-0 rounded-full ${STATUS_COLORS[f.status as keyof typeof STATUS_COLORS] ?? STATUS_COLORS.stopped}`} />

              {/* Mapping info */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="font-mono text-white/70">{f.externalPort}</span>
                  <span className="text-[10px] text-white/30">→</span>
                  <span className="font-mono text-white/70">
                    {f.internalHost}:{f.internalPort}
                  </span>
                  <span
                    className={`rounded px-1 py-0.5 text-[9px] font-medium ${
                      f.protocol === 'tcp' ? 'bg-cyan-500/20 text-cyan-400' : 'bg-violet-500/20 text-violet-400'
                    }`}
                  >
                    {f.protocol.toUpperCase()}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-3 text-[10px] text-white/30">
                  <span>
                    {t('forward.activeConns')}: {f.activeConns}
                  </span>
                  <span>
                    {t('forward.totalConns')}: {f.totalConns}
                  </span>
                  {f.startedAt && <span>{formatUptime(f.startedAt)}</span>}
                  {f.error && <span className="text-red-400/80">{f.error}</span>}
                </div>
              </div>

              {/* Actions */}
              <div className="flex shrink-0 gap-1">
                <button type="button" onClick={() => handleRemove(f.id)} className={btnDanger}>
                  {t('forward.stopAndRemove')}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </CommonTileContainer>
  )
}
