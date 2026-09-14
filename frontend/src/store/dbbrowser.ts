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
export const dbSelectedTableAtom = atom<string | null>(null)

// Saved connections (persisted to localStorage)
const SAVED_CONNECTIONS_KEY = 'suwu_db_saved_connections'

function loadSavedConnections(): SavedConnection[] {
  try {
    const raw = localStorage.getItem(SAVED_CONNECTIONS_KEY)
    return raw ? JSON.parse(raw) : []
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
    const exists = current.findIndex((c) => c.id === connection.id)
    let next: SavedConnection[]
    if (exists >= 0) {
      next = [...current]
      next[exists] = connection
    } else {
      next = [...current, connection]
    }
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
