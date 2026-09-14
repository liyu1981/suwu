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
  onSave: (connection: SavedConnection) => void
  onDelete: (id: string) => void
}

const DRIVER_DEFAULTS: Record<DriverType, { port: number; sslMode: string }> = {
  sqlite: { port: 0, sslMode: '' },
  mysql: { port: 3306, sslMode: 'disable' },
  postgres: { port: 5432, sslMode: 'disable' },
}

export default function ConnectionDialog({
  savedConnections,
  onConnect,
  onSave,
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
  const [connectionLabel, setConnectionLabel] = useState('')

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

    if (driver !== 'sqlite') {
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

  const handleSave = useCallback(() => {
    const label =
      connectionLabel ||
      `${driver}://${driver === 'sqlite' ? sqlitePath : `${host || 'localhost'}:${port || DRIVER_DEFAULTS[driver].port}/${database}`}`

    onSave({
      id: `conn_${Date.now()}`,
      label,
      driver,
      host: driver !== 'sqlite' ? host : undefined,
      port: driver !== 'sqlite' ? (port ? Number.parseInt(port, 10) : undefined) : undefined,
      database: driver === 'sqlite' ? sqlitePath : database,
      user: driver !== 'sqlite' ? user : undefined,
      sqlitePath: driver === 'sqlite' ? sqlitePath : undefined,
      sslMode: driver !== 'sqlite' ? sslMode : undefined,
    })
    setConnectionLabel('')
  }, [connectionLabel, driver, host, port, database, user, sqlitePath, sslMode, onSave])

  const handleLoadSaved = useCallback((conn: SavedConnection) => {
    setDriver(conn.driver)
    setHost(conn.host || 'localhost')
    setPort(conn.port ? String(conn.port) : '')
    setDatabase(conn.database || '')
    setUser(conn.user || '')
    setSqlitePath(conn.sqlitePath || '')
    setSslMode(conn.sslMode || 'disable')
    setConnectionLabel(conn.label)
  }, [])

  const inputClass =
    'w-full rounded-md bg-white/[0.06] border border-white/[0.10] px-2.5 py-1.5 text-white/90 placeholder-white/30 outline-none transition-all focus:border-cyan-500/40 focus:bg-white/[0.10] focus:ring-1 focus:ring-cyan-500/20'

  const isSqlite = driver === 'sqlite'

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-white/[0.10] bg-white/[0.02]">
      {/* Header */}
      <div className="flex shrink-0 items-center border-b border-white/[0.06] px-3 py-2">
        <span className="font-semibold text-white/70">
          {t('dbbrowser.connect')}
        </span>
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-3">
        {/* Saved connections */}
        {savedConnections.length > 0 && (
          <div className="mb-3">
            <div className="mb-1 font-semibold uppercase tracking-wider text-white/30">
              {t('dbbrowser.savedConnections')}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {savedConnections.map((conn) => (
                <div
                  key={conn.id}
                  className="group flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 transition-colors hover:bg-white/[0.08]"
                >
                  <button
                    type="button"
                    onClick={() => handleLoadSaved(conn)}
                    className="text-white/60 transition-colors hover:text-white/80"
                  >
                    {conn.label}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(conn.id)}
                    className="text-white/20 transition-colors hover:text-red-400/80 opacity-0 group-hover:opacity-100"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Driver selector */}
        <div className="mb-3">
          <label className="mb-1 block font-semibold uppercase tracking-wider text-white/30">
            {t('dbbrowser.driver')}
          </label>
          <div className="flex overflow-hidden rounded-lg border border-white/[0.10] bg-white/[0.04]">
            {(['sqlite', 'mysql', 'postgres'] as DriverType[]).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => handleDriverChange(d)}
                className={`flex-1 px-2.5 py-1.5 font-semibold tracking-wide transition-all ${
                  driver === d
                    ? 'bg-cyan-500/20 text-cyan-300'
                    : 'text-white/45 hover:bg-white/[0.08] hover:text-white/65'
                }`}
              >
                {d.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Connection fields */}
        <div className="space-y-2">
          {isSqlite ? (
            <div>
              <label className="mb-1 block font-semibold uppercase tracking-wider text-white/30">
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
                  <label className="mb-1 block font-semibold uppercase tracking-wider text-white/30">
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
                  <label className="mb-1 block font-semibold uppercase tracking-wider text-white/30">
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
                <label className="mb-1 block font-semibold uppercase tracking-wider text-white/30">
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
                  <label className="mb-1 block font-semibold uppercase tracking-wider text-white/30">
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
                  <label className="mb-1 block font-semibold uppercase tracking-wider text-white/30">
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
                <label className="mb-1 block font-semibold uppercase tracking-wider text-white/30">
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
          <div className="mt-2 rounded-md border border-red-500/20 bg-red-500/10 px-2.5 py-1.5 text-red-400">
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={handleConnect}
            disabled={connecting || (isSqlite ? !sqlitePath : !database)}
            className="flex-1 rounded-lg bg-cyan-500/25 px-3 py-1.5 font-medium text-cyan-300 transition-all hover:bg-cyan-500/35 hover:text-cyan-200 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-30"
          >
            {connecting ? '...' : t('dbbrowser.connect')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={isSqlite ? !sqlitePath : !database}
            className="rounded-lg bg-white/[0.06] px-3 py-1.5 font-medium text-white/60 transition-all hover:bg-white/[0.10] hover:text-white/80 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-30"
          >
            {t('dbbrowser.saveConnection')}
          </button>
        </div>
      </div>
    </div>
  )
}
