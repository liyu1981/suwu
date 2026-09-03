# Tile Plugin App - Git Graph Implementation

## Status: ✅ COMPLETE

The git graph tile plugin has been successfully implemented and integrated into the tiling window manager.

## What Was Built

### 1. Graph Algorithm (`graph.ts`)
- Adapted vscode-git-graph's rendering algorithm
- Branch lane assignment and topology
- Curved/angular path generation
- Support for merges, forks, stashes, tags

### 2. React Components
- `GraphRenderer` - SVG-based graph visualization
- `useGitGraph` - Data fetching hook
- `GitGraphTile` - Complete tile component
- `GitGraphPage` - Full-space route page

### 3. Tile Plugin Integration
- Registered in `tilePlugins.ts`
- Toolbar with refresh button
- Session state persistence
- AppIcon in tile picker

### 4. Backend API
- `/api/git/commits` - Fetch commit history
- `/api/git/commit` - Get commit details
- `/api/git/branches` - List branches

## Files Created

```
frontend/src/
├── components/gitgraph/
│   ├── index.ts
│   ├── graph.ts              (18KB - core algorithm)
│   ├── GraphRenderer.tsx     (6KB - SVG renderer)
│   ├── useGitGraph.ts        (4KB - data hook)
│   └── GitGraphTile.tsx      (11KB - tile component)
├── routes/
│   └── GitGraphPage.tsx      (10KB - page)
└── wm/
    ├── plugins/
    │   └── gitgraph.tsx      (2KB - plugin)
    └── sessionState.ts       (added GitGraphSessionState)

pkg/server/
└── git.go                    (11KB - API handlers)
```

## How to Use

1. Start the server:
   ```bash
   ./Suwu serve
   ```

2. Open browser to `http://localhost:8080`

3. Click "+" to add a new tile

4. Select "Git Graph" from the picker

5. The graph will display commits from the current repository

## Testing

```bash
# Build frontend
cd frontend && npm run build

# Build backend
go build ./...

# Run tests
go test ./...
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    TilingWM (Parent)                     │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────┐   │
│  │              GitGraphPage (iframe)               │   │
│  │  ┌─────────────────────────────────────────┐   │   │
│  │  │         CommonTileContainer              │   │   │
│  │  │  ┌─────────────────────────────────┐   │   │   │
│  │  │  │       GraphRenderer (SVG)        │   │   │   │
│  │  │  │  ┌───┐  ┌───┐  ┌───┐  ┌───┐   │   │   │   │
│  │  │  │  │ ○─┼──┼─○─┼──┼─○─┼──┼─○ │   │   │   │   │
│  │  │  │  └───┘  └─┬─┘  └───┘  └───┘   │   │   │   │
│  │  │  │           │                     │   │   │   │
│  │  │  │           └─────────────○       │   │   │   │
│  │  │  └─────────────────────────────────┘   │   │   │
│  │  └─────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────┤
│                    Go Backend                           │
│  ┌─────────────────────────────────────────────────┐   │
│  │  /api/git/commits  →  git log  →  JSON         │   │
│  │  /api/git/commit   →  git show →  JSON         │   │
│  │  /api/git/branches →  git branch → JSON        │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## Next Steps

The core implementation is complete. Future enhancements could include:

1. **Interactive Git Operations** - Checkout, merge, rebase from the UI
2. **Diff Viewer** - Full file diff comparison
3. **Real-time Updates** - WebSocket-based file watching
4. **Code Review** - Track reviewed files
5. **Search/Filter** - Find commits by message, author, date
6. **Avatar Support** - Gravatar integration

## Credits

- Graph algorithm from [vscode-git-graph](https://github.com/mhutchie/vscode-git-graph) (MIT License)
- UI follows glass-webui-design system
- Tile system follows tile-plugin-system architecture
