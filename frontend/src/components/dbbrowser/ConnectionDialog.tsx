import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { DriverType, SavedConnection } from '../../store/dbbrowser'

interface ConnectionDialogProps {
  savedConnections: SavedConnection[]
  onConnect: (params: {
    driver: DriverType
    host?: string
    port?: number
    database: string
    user?: string
    password?: string
    sqlitePath?: string
    sslMode?: string
  }) => Promise<{ success: boolean; error?: string }>
  onDelete: (id: string) => void
}

const DRIVERS: DriverType[] = ['sqlite', 'mysql', 'postgres']

const DRIVER_DEFAULTS: Record<DriverType, { port: number; sslMode: string }> = {
  sqlite: { port: 0, sslMode: '' },
  mysql: { port: 3306, sslMode: 'disable' },
  postgres: { port: 5432, sslMode: 'disable' },
}

const DRIVER_ACCENT: Record<DriverType, string> = {
  sqlite: 'bg-sky-400',
  mysql: 'bg-orange-400',
  postgres: 'bg-cyan-400',
}

export default function ConnectionDialog({
  savedConnections,
  onConnect,
  onDelete,
}: ConnectionDialogProps) {
  const { t } = useTranslation()
  const [driver, setDriver] = useState<DriverType>('sqlite')
  const [host, setHost] = useState('localhost')
  const [port, setPort] = useState('')
  const [database, setDatabase] = useState('')
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [sqlitePath, setSqlitePath] = useState('')
  const [sslMode, setSslMode] = useState('disable')
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleDriverChange = useCallback((newDriver: DriverType) => {
    setDriver(newDriver)
    setPort('')
    setError(null)
    if (newDriver === 'sqlite') {
      setHost('')
      setUser('')
      setPassword('')
    } else {
      setHost('localhost')
      setSqlitePath('')
    }
  }, [])

  const handleConnect = useCallback(async () => {
    setError(null)
    setConnecting(true)

    const params: {
      driver: DriverType
      host?: string
      port?: number
      database: string
      user?: string
      password?: string
      sqlitePath?: string
      sslMode?: string
    } = {
      driver,
      database: driver === 'sqlite' ? sqlitePath : database,
      sslMode,
    }

    if (driver === 'sqlite') {
      params.sqlitePath = sqlitePath
    } else {
      params.host = host || undefined
      params.port = port ? Number.parseInt(port, 10) : undefined
      params.user = user || undefined
      params.password = password || undefined
    }

    const result = await onConnect(params)
    setConnecting(false)

    if (!result.success && result.error) {
      setError(result.error)
    }
  }, [driver, host, port, database, user, password, sqlitePath, sslMode, onConnect])

  const handleLoadSaved = useCallback((conn: SavedConnection) => {
    setDriver(conn.driver)
    setHost(conn.host || 'localhost')
    setPort(conn.port ? String(conn.port) : '')
    setDatabase(conn.database || '')
    setUser(conn.user || '')
    setSqlitePath(conn.sqlitePath || (conn.driver === 'sqlite' ? conn.database : '') || '')
    setSslMode(conn.sslMode || 'disable')
    setError(null)
  }, [])

  const inputClass =
    'w-full rounded-md bg-white/[0.06] border border-white/[0.10] px-2.5 py-1.5 text-sm text-white/90 placeholder-white/30 outline-none transition-all focus:border-cyan-500/40 focus:bg-white/[0.10] focus:ring-1 focus:ring-cyan-500/20'

  const isSqlite = driver === 'sqlite'
  const recentForDriver = savedConnections.filter((c) => c.driver === driver)

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-white/[0.10] bg-white/[0.02]">
      {/* Header */}
      <div className="flex shrink-0 items-center border-b border-white/[0.06] px-3 py-2">
        <span className="text-base font-semibold text-white/70">{t('dbbrowser.newConnection')}</span>
      </div>

      {/* Body: vertical tabs + content */}
      <div className="flex min-h-0 flex-1">
        {/* Vertical driver tabs */}
        <div className="flex w-32 shrink-0 flex-col gap-1 border-r border-white/[0.06] p-2">
          {DRIVERS.map((d) => {
            const active = driver === d
            return (
              <button
                key={d}
                type="button"
                onClick={() => handleDriverChange(d)}
                className={`group relative flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs font-semibold tracking-wide transition-all ${
                  active
                    ? 'bg-cyan-500/15 text-cyan-300'
                    : 'text-white/45 hover:bg-white/[0.06] hover:text-white/70'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    active ? DRIVER_ACCENT[d] : 'bg-white/20'
                  }`}
                />
                <span className="min-w-0 flex-1 truncate">{d.toUpperCase()}</span>
                {active && (
                  <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-cyan-400" />
                )}
              </button>
            )
          })}
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-3">
          {/* Recent connections for the active driver */}
          <div className="mb-3">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-white/30">
              {t('dbbrowser.recentConnections')}
            </div>
            {recentForDriver.length > 0 ? (
              <div className="flex flex-col gap-1">
                {recentForDriver.map((conn) => (
                  <div
                    key={conn.id}
                    className="group flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 transition-colors hover:bg-white/[0.08]"
                  >
                    <button
                      type="button"
                      onClick={() => handleLoadSaved(conn)}
                      title={conn.label}
                      className="min-w-0 flex-1 truncate text-left text-xs text-white/70 transition-colors hover:text-white/90"
                    >
                      {conn.label}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleLoadSaved(conn)}
                      title={t('dbbrowser.load')}
                      className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-cyan-300/70 transition-colors hover:bg-cyan-500/15 hover:text-cyan-200"
                    >
                      {t('dbbrowser.load')}
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(conn.id)}
                      aria-label={t('dbbrowser.deleteConnection')}
                      className="shrink-0 px-1 text-xs text-white/20 opacity-0 transition-colors hover:text-red-400/80 group-hover:opacity-100"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-dashed border-white/[0.08] px-2 py-1.5 text-[11px] text-white/25">
                {t('dbbrowser.noRecentConnections')}
              </div>
            )}
          </div>

          {/* Connection fields */}
          <div className="space-y-2">
            {isSqlite ? (
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-white/30">
                  {t('dbbrowser.sqlitePath')}
                </label>
                <input
                  type="text"
                  value={sqlitePath}
                  onChange={(e) => setSqlitePath(e.target.value)}
                  placeholder="/path/to/database.db"
                  className={inputClass}
                />
              </div>
            ) : (
              <>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-white/30">
                      {t('dbbrowser.host')}
                    </label>
                    <input
                      type="text"
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                      placeholder="localhost"
                      className={inputClass}
                    />
                  </div>
                  <div className="w-20">
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-white/30">
                      {t('dbbrowser.port')}
                    </label>
                    <input
                      type="number"
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                      placeholder={String(DRIVER_DEFAULTS[driver].port)}
                      className={inputClass}
                    />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-white/30">
                    {t('dbbrowser.database')}
                  </label>
                  <input
                    type="text"
                    value={database}
                    onChange={(e) => setDatabase(e.target.value)}
                    placeholder="mydb"
                    className={inputClass}
                  />
                </div>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-white/30">
                      {t('dbbrowser.user')}
                    </label>
                    <input
                      type="text"
                      value={user}
                      onChange={(e) => setUser(e.target.value)}
                      placeholder="root"
                      className={inputClass}
                    />
                  </div>
                  <div className="flex-1">
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-white/30">
                      {t('dbbrowser.password')}
                    </label>
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••"
                      className={inputClass}
                    />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-white/30">
                    SSL Mode
                  </label>
                  <select
                    value={sslMode}
                    onChange={(e) => setSslMode(e.target.value)}
                    className={inputClass}
                  >
                    <option value="disable">Disable</option>
                    <option value="require">Require</option>
                    <option value="verify-ca">Verify CA</option>
                    <option value="verify-full">Verify Full</option>
                  </select>
                </div>
              </>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="mt-2 rounded-md border border-red-500/20 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-400">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={handleConnect}
              disabled={connecting || (isSqlite ? !sqlitePath : !database)}
              className="flex-1 rounded-lg bg-cyan-500/25 px-3 py-1.5 text-xs font-medium text-cyan-300 transition-all hover:bg-cyan-500/35 hover:text-cyan-200 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-30"
            >
              {connecting ? '...' : t('dbbrowser.connect')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
