import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getCredentials } from '../lib/auth'
import { CommonTileContainer } from './CommonTileContainer'
import { RefreshIcon } from './icons'
import { forwardZoomAtom } from '../store/zoom'

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

const AUTO_REFRESH_INTERVALS = [
  { label: 'Off', value: 0 },
  { label: '5s', value: 5000 },
  { label: '10s', value: 10000 },
  { label: '30s', value: 30000 },
  { label: '60s', value: 60000 },
] as const

const inputClass =
  'rounded-lg bg-white/[0.08] border border-white/[0.12] px-2.5 py-1.5 text-xs text-white/90 placeholder-white/35 outline-none transition-all duration-150 focus:bg-white/[0.14] focus:ring-1'

const inputValid = 'focus:border-green-500/40 focus:ring-green-500/20'
const inputInvalid = 'border-red-500/40 focus:border-red-500/40 focus:ring-red-500/20'

const btnPrimary =
  'shrink-0 rounded-lg bg-cyan-500/25 px-3.5 py-1.5 text-xs font-medium text-cyan-300 transition-all duration-150 hover:bg-cyan-500/35 hover:text-cyan-200 active:scale-[0.97] disabled:opacity-30 disabled:cursor-not-allowed'

const btnDanger =
  'rounded-lg bg-red-500/15 px-2 py-1 text-[10px] font-medium text-red-400/80 transition-all duration-150 hover:bg-red-500/25 hover:text-red-400 active:scale-[0.97]'

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

  // Auto-refresh (file-viewer style: interval dropdown)
  const [autoRefresh, setAutoRefresh] = useState(0)
  const [showDropdown, setShowDropdown] = useState(false)
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 })
  const dropdownRef = useRef<HTMLDivElement>(null)
  const autoBtnRef = useRef<HTMLButtonElement>(null)

  // Close the auto-refresh dropdown on outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

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

  // Status polling — controlled by the auto-refresh interval dropdown
  // (Off = manual refresh only, otherwise poll at the chosen interval).
  useEffect(() => {
    if (autoRefresh <= 0) return
    const timer = setInterval(() => {
      fetchStatus()
      fetchServerPorts()
    }, autoRefresh)
    return () => clearInterval(timer)
  }, [autoRefresh, fetchStatus, fetchServerPorts])

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
    <CommonTileContainer zoomAtom={forwardZoomAtom}>
      <div className="flex h-full flex-col">
        {/* Header — glass material */}
        <div className="flex shrink-0 items-center rounded-t-lg border-b border-white/[0.06] px-3 py-2 glass-control">
          {/* Refresh button (left) */}
          <button
            type="button"
            onClick={() => { fetchStatus(); fetchServerPorts() }}
            className={`grid h-5 w-5 place-items-center rounded-md transition-all duration-150 hover:bg-white/[0.08] active:scale-90 ${
              autoRefresh > 0 ? 'text-green-400 hover:text-green-300' : 'text-white/30 hover:text-white/60'
            }`}
            title={t('forward.refreshPorts')}
          >
            <RefreshIcon className="h-3 w-3" />
          </button>
          {/* Auto-refresh dropdown trigger (file-viewer design) */}
          <button
            ref={autoBtnRef}
            type="button"
            onClick={() => {
              if (showDropdown) {
                setShowDropdown(false)
              } else if (autoBtnRef.current) {
                const rect = autoBtnRef.current.getBoundingClientRect()
                setDropdownPos({ top: rect.bottom + 2, left: rect.left })
                setShowDropdown(true)
              }
            }}
            className={`grid h-5 w-4 place-items-center rounded text-[10px] transition-all duration-150 hover:bg-white/[0.08] ${
              autoRefresh > 0 ? 'text-green-400' : 'text-white/30 hover:text-white/60'
            }`}
            title="Auto-refresh interval"
          >
            ▾
          </button>
          <span className="ml-1.5 text-[11px] font-semibold tracking-wide text-white/60">{t('forward.title')}</span>
          <div className="flex-1" />
        </div>

        {/* Auto-refresh dropdown (portal-like, matches file viewer) */}
        {showDropdown && (
          <div
            ref={dropdownRef}
            className="fixed z-[9999] w-28 rounded border border-white/10 bg-black/95 py-1 shadow-xl backdrop-blur-xl"
            style={{ top: dropdownPos.top, left: dropdownPos.left }}
          >
            {AUTO_REFRESH_INTERVALS.map((iv) => (
              <button
                key={iv.value}
                type="button"
                onClick={() => { setAutoRefresh(iv.value); setShowDropdown(false) }}
                className={`flex w-full items-center px-3 py-1 text-left text-xs transition hover:bg-white/10 ${
                  autoRefresh === iv.value ? 'text-green-400' : 'text-white/60'
                }`}
              >
                {iv.label}
                {autoRefresh === iv.value && iv.value > 0 && (
                  <span className="ml-auto text-[10px] text-green-400/60">●</span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Config row — glass material with better spacing */}
        <div className="flex shrink-0 items-center gap-2 border-x border-x-white/[0.10] border-b border-b-white/[0.08] bg-white/[0.05] px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
          {/* Protocol toggle — pill style */}
          <div className="flex shrink-0 overflow-hidden rounded-lg border border-white/[0.10] bg-white/[0.04]">
            <button
              type="button"
              onClick={() => setProtocol('tcp')}
              className={`px-2.5 py-1 text-[10px] font-semibold tracking-wide transition-all duration-150 ${
                protocol === 'tcp'
                  ? 'bg-cyan-500/20 text-cyan-300'
                  : 'text-white/45 hover:bg-white/[0.08] hover:text-white/65'
              }`}
            >
              {t('forward.tcp')}
            </button>
            <button
              type="button"
              onClick={() => setProtocol('udp')}
              className={`px-2.5 py-1 text-[10px] font-semibold tracking-wide transition-all duration-150 ${
                protocol === 'udp'
                  ? 'bg-violet-500/20 text-violet-300'
                  : 'text-white/45 hover:bg-white/[0.08] hover:text-white/65'
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
            className={`${inputClass} ${extPortMsg ? inputInvalid : inputValid} w-20 tabular-nums`}
          />

          <span className="text-[10px] text-white/35">→</span>

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
            className={`${inputClass} ${intPortMsg ? inputInvalid : inputValid} w-20 tabular-nums`}
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

        {/* Validation messages — subtle material strip */}
        {(extPortMsg || intPortMsg || showIntPortWarning || error) && (
          <div className="flex shrink-0 flex-wrap gap-3 border-x border-x-white/[0.10] border-b border-b-white/[0.08] bg-white/[0.05] px-3 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
            {extPortMsg && <span className="text-[10px] font-medium text-red-400">{t('forward.portOccupied')}</span>}
            {intPortMsg && <span className="text-[10px] font-medium text-red-400">Int: {intPortMsg}</span>}
            {showIntPortWarning && (
              <span className="text-[10px] font-medium text-amber-400">
                ⚠ Port {intPort} is not open on {intHost || 'localhost'}
              </span>
            )}
            {error && <span className="text-[10px] font-medium text-red-400">{error}</span>}
          </div>
        )}

        {/* Active mappings list */}
        <div className="min-h-0 flex-1 overflow-y-auto rounded-b-lg border-x border-b border-x-white/[0.10] border-b-white/[0.10] bg-white/[0.04] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
          {loading && (
            <div className="flex items-center justify-center py-12 text-[11px] text-white/40">Loading...</div>
          )}
          {!loading && forwards.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-[11px] text-white/40">
              <svg className="mb-2 h-6 w-6 text-white/25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <line x1="19" y1="8" x2="19" y2="14" />
                <line x1="22" y1="11" x2="16" y2="11" />
              </svg>
              {t('forward.noMappings')}
            </div>
          )}
          {forwards.map((f) => (
            <div
              key={f.id}
              className="group flex items-center gap-3 border-b border-white/[0.06] px-3 py-2.5 transition-all duration-150 hover:bg-white/[0.06]"
            >
              {/* Status dot with glow */}
              <div className="relative shrink-0">
                <div className={`h-2 w-2 rounded-full ${STATUS_COLORS[f.status as keyof typeof STATUS_COLORS] ?? STATUS_COLORS.stopped}`} />
                {f.status === 'running' && (
                  <div className="absolute inset-0 h-2 w-2 animate-pulse rounded-full bg-green-500/40" />
                )}
              </div>

              {/* Mapping info */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[12px]">
                  <span className="font-mono tabular-nums text-white/80">{f.externalPort}</span>
                  <span className="text-[10px] text-white/40">→</span>
                  <span className="font-mono tabular-nums text-white/80">
                    {f.internalHost}:{f.internalPort}
                  </span>
                  <span
                    className={`rounded-md px-1.5 py-0.5 text-[9px] font-semibold tracking-wide ${
                      f.protocol === 'tcp' ? 'bg-cyan-500/15 text-cyan-400' : 'bg-violet-500/15 text-violet-400'
                    }`}
                  >
                    {f.protocol.toUpperCase()}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-3 text-[10px] tabular-nums text-white/40">
                  <span>
                    {t('forward.activeConns')}: {f.activeConns}
                  </span>
                  <span>
                    {t('forward.totalConns')}: {f.totalConns}
                  </span>
                  {f.startedAt && <span>{formatUptime(f.startedAt)}</span>}
                  {f.error && <span className="text-red-400">{f.error}</span>}
                </div>
              </div>

              {/* Actions — reveal on hover */}
              <div className="flex shrink-0 gap-1 opacity-50 transition-opacity duration-150 group-hover:opacity-100">
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
