import { useCallback } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import {
  dbConnectionAtom,
  dbSchemaAtom,
  dbSavedConnectionsAtom,
  saveDBConnectionAtom,
  deleteDBConnectionAtom,
  type DBConnection,
  type TableInfo,
  type DriverType,
} from '../../../store/dbbrowser'
import { authFetch } from '../../../lib/api'

interface ConnectParams {
  driver: DriverType
  host?: string
  port?: number
  database: string
  user?: string
  password?: string
  sqlitePath?: string
  sslMode?: string
}

interface ConnectResponse {
  sessionId?: string
  tables?: TableInfo[]
  error?: string
}

export function useDBSession() {
  const [connection, setConnection] = useAtom(dbConnectionAtom)
  const [schema, setSchema] = useAtom(dbSchemaAtom)
  const [savedConnections] = useAtom(dbSavedConnectionsAtom)
  const saveConnection = useSetAtom(saveDBConnectionAtom)
  const deleteConnection = useSetAtom(deleteDBConnectionAtom)

  const connect = useCallback(
    async (params: ConnectParams): Promise<{ success: boolean; error?: string }> => {
      try {
        const res = await authFetch('/api/db/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        })

        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as ConnectResponse
          return { success: false, error: body.error || `HTTP ${res.status}` }
        }

        const body = (await res.json()) as ConnectResponse
        if (body.error) {
          return { success: false, error: body.error }
        }

        if (!body.sessionId) {
          return { success: false, error: 'No session ID returned' }
        }

        const newConnection: DBConnection = {
          sessionId: body.sessionId,
          driver: params.driver,
          database: params.database,
          host: params.host,
          port: params.port,
          connectedAt: Date.now(),
        }

        setConnection(newConnection)
        setSchema(body.tables || [])

        // Remember this connection (keeps the last 5 per driver).
        const label =
          params.driver === 'sqlite'
            ? params.sqlitePath || params.database
            : `${params.host || 'localhost'}:${params.port || ''}/${params.database}`
        saveConnection({
          id: `conn_${Date.now()}`,
          label,
          driver: params.driver,
          host: params.driver !== 'sqlite' ? params.host : undefined,
          port: params.driver !== 'sqlite' ? params.port : undefined,
          database: params.database,
          user: params.driver !== 'sqlite' ? params.user : undefined,
          sqlitePath: params.driver === 'sqlite' ? params.sqlitePath : undefined,
          sslMode: params.driver !== 'sqlite' ? params.sslMode : undefined,
        })

        return { success: true }
      } catch (e) {
        return {
          success: false,
          error: e instanceof Error ? e.message : 'Connection failed',
        }
      }
    },
    [setConnection, setSchema, saveConnection],
  )

  const disconnect = useCallback(async () => {
    if (!connection) return

    try {
      await authFetch('/api/db/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: connection.sessionId }),
      })
    } catch {
      // silent
    }

    setConnection(null)
    setSchema([])
  }, [connection, setConnection, setSchema])

  const refreshSchema = useCallback(async () => {
    if (!connection) return

    try {
      const res = await authFetch(`/api/db/tables?session=${connection.sessionId}`)
      if (res.ok) {
        const tables = (await res.json()) as TableInfo[]
        setSchema(tables)
      }
    } catch {
      // silent
    }
  }, [connection, setSchema])

  return {
    connection,
    schema,
    savedConnections,
    connect,
    disconnect,
    refreshSchema,
    saveConnection,
    deleteConnection,
  }
}
