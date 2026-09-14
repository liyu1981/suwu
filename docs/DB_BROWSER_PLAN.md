# DB Browser Feature Plan

## Overview

A database browser tile that lets users connect to SQLite, MySQL, or PostgreSQL databases, write SQL in a syntax-highlighted editor, execute queries, and view results in a rich data table.

---

## Architecture

### Data Flow

```
Browser (React)
  ┌─────────────────────────────────────────────────┐
  │  DBBrowserPanel                                  │
  │  ┌──────────────┐  ┌──────────────────────────┐ │
  │  │ Connection    │  │ SQL Editor (Monaco)      │ │
  │  │ Manager       │  │                          │ │
  │  └──────────────┘  └──────────────────────────┘ │
  │  ┌──────────────────────────────────────────────┐│
  │  │ Data Table (@tanstack/react-table)           ││
  │  │ - Column sorting, filtering                  ││
  │  │ - Pagination                                 ││
  │  │ - Virtual scrolling for large results        ││
  │  └──────────────────────────────────────────────┘│
  │  ┌──────────────────────────────────────────────┐│
  │  │ Status Bar (row count, execution time, etc.) ││
  │  └──────────────────────────────────────────────┘│
  └──────────────────────┬──────────────────────────┘
                         │ HTTP REST API
                         ▼
Go Backend (pkg/server/dbbrowser.go)
  ┌─────────────────────────────────────────────────┐
  │  /api/db/connect     - Validate & test connection│
  │  /api/db/disconnect  - Close a session           │
  │  /api/db/sessions    - List active sessions      │
  │  /api/db/execute     - Run SQL, return results   │
  │  /api/db/tables      - List tables (schema probe)│
  │  /api/db/describe    - Describe table columns    │
  └──────────────────────┬──────────────────────────┘
                         │
                         ▼
  ┌─────────────────────────────────────────────────┐
  │  pkg/db/ (new package)                          │
  │  - Driver abstraction (sqlite, mysql, postgres) │
  │  - Connection pool / session manager            │
  │  - Query execution with timeout & row limits    │
  └─────────────────────────────────────────────────┘
```

---

## Backend Design

### 1. New Package: `pkg/db/`

**File: `pkg/db/db.go`** — Core types and interface

```go
package db

// DriverType enumerates supported database drivers.
type DriverType string

const (
    DriverSQLite   DriverType = "sqlite"
    DriverMySQL    DriverType = "mysql"
    DriverPostgres DriverType = "postgres"
)

// ConnectionParams holds client-provided connection info.
// Credentials are NEVER persisted — held in memory only.
type ConnectionParams struct {
    Driver   DriverType `json:"driver"`
    Host     string     `json:"host,omitempty"`     // not used for sqlite
    Port     int        `json:"port,omitempty"`      // not used for sqlite
    Database string     `json:"database"`            // file path for sqlite, db name for others
    User     string     `json:"user,omitempty"`
    Password string     `json:"password,omitempty"`
    // SQLite-specific
    SQLitePath string `json:"sqlitePath,omitempty"` // absolute path to .db file
    // SSL/TLS options for mysql/postgres
    SSLMode string `json:"sslMode,omitempty"` // disable, require, etc.
}

// QueryResult holds the output of a SQL execution.
type QueryResult struct {
    Columns      []ColumnMeta       `json:"columns"`
    Rows         [][]interface{}    `json:"rows"`
    RowsAffected int64              `json:"rowsAffected"`
    Milliseconds int64              `json:"milliseconds"`
    Error        string             `json:"error,omitempty"`
    Truncated    bool               `json:"truncated"`      // true if hit row limit
}

// ColumnMeta describes a result column.
type ColumnMeta struct {
    Name     string `json:"name"`
    DataType string `json:"dataType"` // display type from driver
}

// TableInfo for schema browsing.
type TableInfo struct {
    Name   string       `json:"name"`
    Schema string       `json:"schema,omitempty"`
    Type   string       `json:"type"` // table, view, etc.
}

// ColumnInfo for table structure.
type ColumnInfo struct {
    Name         string  `json:"name"`
    DataType     string  `json:"dataType"`
    Nullable     bool    `json:"nullable"`
    DefaultValue *string `json:"defaultValue,omitempty"`
    IsPrimaryKey bool    `json:"isPrimaryKey"`
}
```

**File: `pkg/db/session.go`** — Session manager

```go
package db

// Session represents an active database connection.
type Session struct {
    ID        string
    Params    ConnectionParams
    db        *sql.DB
    createdAt time.Time
}

// Manager holds active sessions keyed by session ID.
// One ConnectionParams can have multiple sessions.
type Manager struct {
    mu       sync.RWMutex
    sessions map[string]*Session
}

// MaxRows limits result size to prevent browser OOM.
const MaxRows = 10000

// QueryTimeout caps individual query execution time.
const QueryTimeout = 30 * time.Second
```

**File: `pkg/db/sqlite.go`**, **`mysql.go`**, **`postgres.go`** — Driver implementations

Each implements a common interface:
```go
type Driver interface {
    Open(params ConnectionParams) (*sql.DB, error)
    ListTables(db *sql.DB) ([]TableInfo, error)
    DescribeTable(db *sql.DB, tableName string) ([]ColumnInfo, error)
}
```

Driver imports (Go side):
- SQLite: `github.com/mattn/go-sqlite3` (CGO) or `modernc.org/sqlite` (pure Go)
- MySQL: `github.com/go-sql-driver/mysql`
- PostgreSQL: `github.com/jackc/pgx/v5/stdlib`

### 2. API Routes in `pkg/server/dbbrowser.go`

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/db/connect` | Validate connection, create session, return session ID |
| POST | `/api/db/disconnect` | Close session by ID |
| GET | `/api/db/sessions` | List all active sessions |
| POST | `/api/db/execute` | Execute SQL against a session, return results |
| GET | `/api/db/tables?session=<id>` | List tables in the connected database |
| GET | `/api/db/describe?session=<id>&table=<name>` | Describe table columns |
| GET | `/api/db/quick-connect` | Quick-connect from URL params (for presets) |

**Request/Response shapes:**

```json
// POST /api/db/connect
// Request:
{
  "driver": "postgres",
  "host": "localhost",
  "port": 5432,
  "database": "mydb",
  "user": "admin",
  "password": "secret"
}
// Response:
{
  "sessionId": "db_1719000000_abc123",
  "tables": ["users", "posts", "comments"]
}

// POST /api/db/execute
// Request:
{
  "sessionId": "db_1719000000_abc123",
  "sql": "SELECT * FROM users WHERE active = true LIMIT 100"
}
// Response:
{
  "columns": [
    {"name": "id", "dataType": "INTEGER"},
    {"name": "name", "dataType": "TEXT"},
    {"name": "email", "dataType": "TEXT"}
  ],
  "rows": [[1, "Alice", "alice@example.com"], ...],
  "rowsAffected": 0,
  "milliseconds": 12,
  "truncated": false
}
```

### 3. Route Registration in `server.go`

Add to the `route()` method alongside existing handlers:

```go
if strings.HasPrefix(r.URL.Path, "/api/db/") {
    s.handleDBBrowser(w, r)
    return
}
```

### 4. Security Considerations

- **Credentials in memory only**: Never written to disk, logs, or localStorage
- **Session timeout**: Idle sessions auto-close after 30 minutes
- **Row limit**: Max 10,000 rows per query to prevent browser OOM
- **Query timeout**: 30-second timeout on all queries
- **No DDL by default**: Optionally restrict to SELECT only (configurable)
- **SQL injection**: Use parameterized queries where possible; for free-form SQL, rely on the database driver's escaping
- **Auth**: All endpoints use existing `validateRequest()` HMAC/token auth

---

## Frontend Design

### 1. New Dependencies

```bash
# SQL syntax highlighting editor
pnpm add @monaco-editor/react

# Data table (shadcn pattern)
pnpm add @tanstack/react-table

# SQLite path picker (if needed)
# No extra dep — just a text input
```

**Monaco Editor vs CodeMirror:**
- **Monaco** (~2MB gzipped): Full VS Code editor, excellent SQL support, built-in autocomplete, familiar UX. Used by VS Code, so SQL highlighting is best-in-class.
- **CodeMirror** (~150KB): Lighter, but needs more setup for SQL. Good enough if bundle size is critical.
- **Recommendation**: Monaco — the SQL experience is significantly better, and this is a developer tool where UX matters more than bundle size.

### 2. Component Structure

```
frontend/src/
├── components/
│   └── dbbrowser/
│       ├── DBBrowserPanel.tsx      # Main panel (like ForwardPanel)
│       ├── ConnectionDialog.tsx    # Connection form dialog
│       ├── SQLEditor.tsx           # Monaco editor wrapper
│       ├── DataTable.tsx           # @tanstack/react-table wrapper
│       ├── SchemaSidebar.tsx       # Table list + column browser
│       ├── StatusBar.tsx           # Execution info bar
│       └── hooks/
│           ├── useDBSession.ts     # Session state management
│           └── useDBQuery.ts       # Query execution hook
├── routes/
│   └── DBBrowserPage.tsx          # Route page (iframe entry)
├── wm/
│   └── plugins/
│       └── dbbrowser.tsx           # Tile plugin registration
```

### 3. Component Details

**DBBrowserPanel.tsx** — Main orchestrator

Layout (vertical split):
```
┌─────────────────────────────────────────────────┐
│ [Connection: mydb ▼] [Connect] [Disconnect]     │ ← Connection bar
├──────────────────┬──────────────────────────────┤
│ Schema Sidebar   │ ┌──────────────────────────┐ │
│                  │ │ SQL Editor (Monaco)      │ │
│ 📁 Tables        │ │ SELECT * FROM users...   │ │
│   ├ users        │ └──────────────────────────┘ │
│   ├ posts        │ ┌──────────────────────────┐ │
│   └ comments     │ │ Data Table               │ │
│                  │ │ id | name | email        │ │
│ 📁 Views         │ │ 1  | Alice| alice@...   │ │
│   └ user_stats   │ │ 2  | Bob  | bob@...     │ │
│                  │ └──────────────────────────┘ │
│ [Click table →   │ Status: 2 rows (12ms)       │
│  inserts SQL]    │                              │
└──────────────────┴──────────────────────────────┘
```

**SQLEditor.tsx** — Monaco wrapper

```tsx
// Key features:
// - Language: 'sql' (Monaco built-in)
// - Theme: match app's dark glass-morphism aesthetic
// - Keybinding: Ctrl+Enter / Cmd+Enter to execute
// - Autocomplete: table/column names from schema
// - Multiple query support: execute selected text or all
```

Monaco theme customization to match the app:
```typescript
const dbTheme: monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: 'c084fc' },    // purple keywords
    { token: 'string', foreground: '86efac' },      // green strings
    { token: 'number', foreground: 'fbbf24' },      // amber numbers
    { token: 'comment', foreground: '6b7280' },     // gray comments
  ],
  colors: {
    'editor.background': '#0f0f1100',               // transparent to show glass
    'editor.foreground': '#fafafa',
    'editor.lineHighlightBackground': '#ffffff08',
    'editorCursor.foreground': '#0ea5e9',
  }
}
```

**DataTable.tsx** — Shadcn-style data table

Following the shadcn data-table pattern (https://ui.shadcn.com/docs/components/radix/data-table):

```tsx
// Features:
// - Dynamic columns from query result
// - Column sorting (client-side)
// - Column resizing
// - Virtual scrolling for large result sets (react-window or tanstack virtual)
// - Cell copy on click
// - NULL display styling
// - JSON/JSONB cell expansion
// - Export to CSV
// - Pagination (client-side for <1000 rows, server-side for larger)
```

Table styling to match glass-morphism:
```css
/* Consistent with existing app design */
.db-table {
  @apply text-[11px] font-mono;
}
.db-table th {
  @apply border-b border-white/10 bg-white/[0.04] px-3 py-1.5 
         text-left font-semibold text-white/60 sticky top-0;
}
.db-table td {
  @apply border-b border-white/[0.04] px-3 py-1 text-white/80;
}
.db-table tr:hover td {
  @apply bg-white/[0.04];
}
```

**SchemaSidebar.tsx** — Database schema browser

- Shows tables and views in a tree
- Click table → inserts `SELECT * FROM <table> LIMIT 100` into editor
- Click column → inserts column name into editor at cursor
- Right-click context menu: "Select", "Describe", "Count"
- Lazy-loads column info on expand

**ConnectionDialog.tsx** — Connection form

- Driver selector (SQLite / MySQL / PostgreSQL)
- Dynamic form fields based on driver:
  - SQLite: file path picker (text input)
  - MySQL/PostgreSQL: host, port, database, user, password
- "Test Connection" button
- Saved connections in localStorage (credentials excluded — only host/port/db/driver saved)
- Connection presets support via URL params

### 4. State Management (Jotai atoms)

```typescript
// frontend/src/store/dbbrowser.ts

export interface DBConnection {
  sessionId: string
  driver: DriverType
  host?: string
  port?: number
  database: string
  connectedAt: number
}

export interface QueryExecution {
  sql: string
  result: QueryResult | null
  loading: boolean
  error: string | null
}

// Atoms
export const dbConnectionAtom = atom<DBConnection | null>(null)
export const dbQueryAtom = atom<QueryExecution>({ sql: '', result: null, loading: false, error: null })
export const dbSchemaAtom = atom<TableInfo[]>([])
export const dbSelectedTableAtom = atom<string | null>(null)
export const dbSavedConnectionsAtom = atom<SavedConnection[]>([])  // persisted to localStorage
```

### 5. Tile Plugin Registration

**File: `frontend/src/wm/plugins/dbbrowser.tsx`**

```typescript
registerTilePlugin({
  id: 'dbbrowser',
  get label() { return i18n.t('plugin.dbbrowser') },
  get description() { return i18n.t('plugin.dbbrowserDesc') },
  supportedParams: [
    { key: 'driver', label: 'Database driver', description: 'sqlite, mysql, or postgres' },
    { key: 'host', label: 'Host', description: 'Database host' },
    { key: 'port', label: 'Port', description: 'Database port' },
    { key: 'database', label: 'Database', description: 'Database name or file path' },
  ],
  render: (paneId, context?: TileRenderContext) => {
    const p = new URLSearchParams({ pane: paneId })
    if (context?.params) {
      for (const [k, v] of Object.entries(context.params)) p.set(k, v)
    }
    return (
      <iframe
        src={`/dbbrowser?${p}`}
        title={`dbbrowser-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-transparent"
      />
    )
  },
})
```

### 6. i18n Keys

```json
{
  "plugin": {
    "dbbrowser": "DB Browser",
    "dbbrowserDesc": "Database query & browser"
  },
  "dbbrowser": {
    "title": "Database Browser",
    "connect": "Connect",
    "disconnect": "Disconnect",
    "testConnection": "Test Connection",
    "connectionSuccess": "Connected successfully",
    "connectionFailed": "Connection failed",
    "driver": "Driver",
    "host": "Host",
    "port": "Port",
    "database": "Database",
    "user": "User",
    "password": "Password",
    "sqlitePath": "Database File",
    "execute": "Execute",
    "executeHint": "Ctrl+Enter to execute",
    "tables": "Tables",
    "views": "Views",
    "columns": "Columns",
    "rows": "rows",
    "executionTime": "ms",
    "noResults": "No results",
    "error": "Error",
    "savedConnections": "Saved Connections",
    "saveConnection": "Save Connection",
    "deleteConnection": "Delete",
    "truncateWarning": "Results truncated ({{max}} row limit)",
    "exportCsv": "Export CSV",
    "copyCell": "Copy",
    "newConnection": "New Connection"
  }
}
```

---

## Multi-Session Support

One `ConnectionParams` can have multiple sessions. This enables:

1. **Parallel queries**: Run a long query in one session while browsing in another
2. **Transaction isolation**: Each session can have its own transaction context
3. **Connection pooling**: Go's `database/sql` handles pooling internally

Session lifecycle:
- Created on "Connect" → stored in `pkg/db.Manager`
- Each query uses the session's `*sql.DB` connection pool
- Idle timeout (30 min) auto-closes unused sessions
- "Disconnect" explicitly closes a session
- Server shutdown closes all sessions via `CloseAll()` pattern (like WebSocket)

---

## Implementation Phases

### Phase 1: Backend Foundation
1. Create `pkg/db/` package with interface and types
2. Implement SQLite driver (simplest, no external server needed)
3. Implement session manager
4. Add API routes in `pkg/server/dbbrowser.go`
5. Wire routes into `server.go`

### Phase 2: Frontend Shell
1. Add dependencies (`@monaco-editor/react`, `@tanstack/react-table`)
2. Create tile plugin registration
3. Create route and page
4. Build connection dialog
5. Build basic panel layout

### Phase 3: SQL Editor + Execution
1. Integrate Monaco editor with SQL language
2. Implement query execution hook
3. Add keyboard shortcuts (Ctrl+Enter)
4. Wire up to backend API

### Phase 4: Data Table
1. Build dynamic data table from query results
2. Add sorting, column resizing
3. Add pagination
4. Add cell interactions (copy, NULL display)

### Phase 5: Schema Browser
1. Build sidebar with table list
2. Add click-to-insert SQL
3. Add table/column describe functionality

### Phase 6: MySQL + PostgreSQL
1. Add MySQL driver
2. Add PostgreSQL driver
3. Test connection forms for each

### Phase 7: Polish
1. Monaco theme matching app aesthetic
2. Virtual scrolling for large results
3. CSV export
4. Connection presets via URL params
5. Session persistence in tiling WM state

---

## Go Dependencies to Add

```go
// go.mod additions
require (
    github.com/mattn/go-sqlite3 v1.14.24    // SQLite (CGO)
    // OR modernc.org/sqlite v1.34.0         // SQLite (pure Go, no CGO)
    github.com/go-sql-driver/mysql v1.8.1   // MySQL
    github.com/jackc/pgx/v5 v5.7.0          // PostgreSQL
)
```

**SQLite driver choice:**
- `go-sqlite3` (CGO): Faster, but requires C compiler on build machine
- `modernc.org/sqlite` (pure Go): Slower, but no CGO dependency — easier cross-compilation

Recommendation: Use `modernc.org/sqlite` for easier builds, switch to `go-sqlite3` if performance is critical.

---

## File Inventory (New Files)

### Backend
```
pkg/db/db.go              # Core types, interface
pkg/db/session.go         # Session manager
pkg/db/sqlite.go          # SQLite driver
pkg/db/mysql.go           # MySQL driver
pkg/db/postgres.go        # PostgreSQL driver
pkg/server/dbbrowser.go   # HTTP handlers
```

### Frontend
```
frontend/src/components/dbbrowser/DBBrowserPanel.tsx
frontend/src/components/dbbrowser/ConnectionDialog.tsx
frontend/src/components/dbbrowser/SQLEditor.tsx
frontend/src/components/dbbrowser/DataTable.tsx
frontend/src/components/dbbrowser/SchemaSidebar.tsx
frontend/src/components/dbbrowser/StatusBar.tsx
frontend/src/components/dbbrowser/hooks/useDBSession.ts
frontend/src/components/dbbrowser/hooks/useDBQuery.ts
frontend/src/routes/DBBrowserPage.tsx
frontend/src/wm/plugins/dbbrowser.tsx
frontend/src/store/dbbrowser.ts
```

### Modified Files
```
pkg/server/server.go                          # Add /api/db/ routes
frontend/src/wm/TilingWM.tsx                  # Import dbbrowser plugin
frontend/src/router.tsx                       # Add /dbbrowser route
frontend/src/locales/en.json                  # Add i18n keys
frontend/src/locales/zh_CN.json               # Add i18n keys
frontend/src/wm/appIcons.ts                   # Add icon entry
frontend/package.json                         # Add @monaco-editor/react, @tanstack/react-table
go.mod / go.sum                               # Add Go DB drivers
```
