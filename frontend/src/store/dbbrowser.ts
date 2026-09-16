import { atom } from 'jotai'

export type DriverType = 'sqlite' | 'mysql' | 'postgres'

export interface DBConnection {
  sessionId: string
  driver: DriverType
  database: string
  host?: string
  port?: number
  connectedAt: number
}

export interface ColumnMeta {
  name: string
  dataType: string
}

export interface QueryResult {
  columns: ColumnMeta[]
  rows: unknown[][]
  rowsAffected: number
  milliseconds: number
  error?: string
  truncated: boolean
}

export interface TableInfo {
  name: string
  schema?: string
  type: string
}

export interface ColumnInfo {
  name: string
  dataType: string
  nullable: boolean
  defaultValue?: string
  isPrimaryKey: boolean
}

export interface QueryExecution {
  sql: string
  result: QueryResult | null
  loading: boolean
  error: string | null
}

export interface SavedConnection {
  id: string
  label: string
  driver: DriverType
  host?: string
  port?: number
  database: string
  user?: string
  sqlitePath?: string
  sslMode?: string
}

// Connection state
export const dbConnectionAtom = atom<DBConnection | null>(null)

// Query state
export const dbQueryAtom = atom<QueryExecution>({
  sql: '',
  result: null,
  loading: false,
  error: null,
})

// Schema
export const dbSchemaAtom = atom<TableInfo[]>([])

// Saved connections (persisted to localStorage)
const SAVED_CONNECTIONS_KEY = 'suwu_db_saved_connections'

// Keep only the most recent N connections per driver type.
export const MAX_SAVED_PER_DRIVER = 5

// A stable fingerprint used to deduplicate the same connection target.
function connectionSignature(c: SavedConnection): string {
  return [
    c.driver,
    c.host ?? '',
    c.port ?? '',
    c.database ?? '',
    c.user ?? '',
    c.sqlitePath ?? '',
    c.sslMode ?? '',
  ].join('|')
}

// Normalize a list: drop duplicate targets, keep newest first, cap per driver.
function normalizeSavedConnections(connections: SavedConnection[]): SavedConnection[] {
  const seen = new Set<string>()
  const perDriver: Record<DriverType, number> = { sqlite: 0, mysql: 0, postgres: 0 }
  const result: SavedConnection[] = []
  for (const conn of connections) {
    const sig = connectionSignature(conn)
    if (seen.has(sig)) continue
    seen.add(sig)
    perDriver[conn.driver] = (perDriver[conn.driver] ?? 0) + 1
    if (perDriver[conn.driver] > MAX_SAVED_PER_DRIVER) continue
    result.push(conn)
  }
  return result
}

function loadSavedConnections(): SavedConnection[] {
  try {
    const raw = localStorage.getItem(SAVED_CONNECTIONS_KEY)
    return raw ? normalizeSavedConnections(JSON.parse(raw)) : []
  } catch {
    return []
  }
}

function saveSavedConnections(connections: SavedConnection[]): void {
  localStorage.setItem(SAVED_CONNECTIONS_KEY, JSON.stringify(connections))
}

export const dbSavedConnectionsAtom = atom<SavedConnection[]>(loadSavedConnections())

// Derived atom for saving connections
export const saveDBConnectionAtom = atom(
  null,
  (get, set, connection: SavedConnection) => {
    const current = get(dbSavedConnectionsAtom)
    const sig = connectionSignature(connection)
    // Drop any existing entry for the same target (and same id), newest first.
    const rest = current.filter(
      (c) => c.id !== connection.id && connectionSignature(c) !== sig,
    )
    const next = normalizeSavedConnections([connection, ...rest])
    set(dbSavedConnectionsAtom, next)
    saveSavedConnections(next)
  },
)

// Derived atom for deleting connections
export const deleteDBConnectionAtom = atom(
  null,
  (get, set, id: string) => {
    const current = get(dbSavedConnectionsAtom)
    const next = current.filter((c) => c.id !== id)
    set(dbSavedConnectionsAtom, next)
    saveSavedConnections(next)
  },
)
