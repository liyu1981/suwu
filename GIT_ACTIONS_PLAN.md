# Git Graph - Git Actions Implementation Plan

## Overview

Add context menu actions to the git graph tile plugin, enabling users to perform git operations directly from the graph UI. This covers all the actions available in vscode-git-graph.

## Architecture

### Message Flow (existing pattern)
```
User right-click → Context Menu → Action Handler → Backend API → Git CLI → Response → UI Update
```

### Components to Build

1. **ContextMenu component** (`frontend/src/components/gitgraph/ContextMenu.tsx`)
   - Reusable context menu with action groups and dividers
   - Positioned relative to click target
   - Keyboard navigation (Escape to close)

2. **ActionDialog component** (`frontend/src/components/gitgraph/ActionDialog.tsx`)
   - Modal dialog for confirming actions with options
   - Support for: confirmation, text input, checkbox, select, radio
   - Replaces vscode-git-graph's dialog.ts

3. **Git actions backend** (`pkg/server/git_actions.go`)
   - Execute git operations via CLI
   - Return success/error status
   - Handle authentication (credential helper)

4. **Action hooks** (`frontend/src/components/gitgraph/useGitActions.ts`)
   - React hooks for each action type
   - Handle loading state, errors, and refresh after action

---

## Phase 1: Context Menu + Dialog System

### Context Menu Component

```tsx
interface ContextMenuItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
}
```

### Dialog Component

Support these input types (matching vscode-git-graph):

| Type | Use Case |
|------|----------|
| Confirmation | "Are you sure you want to delete...?" |
| Text Input | Branch name, tag name |
| Checkbox | Force delete, set upstream, reinstate index |
| Select | Reset mode, parent hash, remote selection |
| Radio | Push mode (normal/force/force-with-lease) |
| Multi-Select | Multiple remotes |

### Context Menu Data Structure

```tsx
interface CommitContextMenuItems {
  // Group 1: Create
  addTag: () => void;
  createBranch: () => void;
  // Group 2: Modify
  checkout: () => void;
  cherryPick: () => void;
  revert: () => void;
  drop: () => void;
  // Group 3: Branch ops
  merge: () => void;
  rebase: () => void;
  reset: () => void;
  // Group 4: Copy
  copyHash: () => void;
  copyMessage: () => void;
}
```

---

## Phase 2: Backend API

### New Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/git/action` | POST | Execute git actions |

### Request Format

```json
{
  "path": "/repo/path",
  "action": "checkout-branch",
  "params": {
    "branch": "feature/my-branch"
  }
}
```

### Action Types

```go
type GitAction string

const (
    // Branch actions
    ActionCreateBranch    GitAction = "create-branch"
    ActionCheckoutBranch  GitAction = "checkout-branch"
    ActionDeleteBranch    GitAction = "delete-branch"
    ActionRenameBranch    GitAction = "rename-branch"
    ActionPushBranch      GitAction = "push-branch"
    ActionPullBranch      GitAction = "pull-branch"
    ActionFetch           GitAction = "fetch"
    
    // Commit actions
    ActionCheckoutCommit  GitAction = "checkout-commit"
    ActionCherryPick      GitAction = "cherry-pick"
    ActionRevert          GitAction = "revert"
    ActionDropCommit      GitAction = "drop-commit"
    ActionResetToCommit   GitAction = "reset-to-commit"
    ActionMerge           GitAction = "merge"
    ActionRebase          GitAction = "rebase"
    
    // Tag actions
    ActionAddTag          GitAction = "add-tag"
    ActionDeleteTag       GitAction = "delete-tag"
    ActionPushTag         GitAction = "push-tag"
    
    // Stash actions
    ActionStash           GitAction = "stash"
    ActionStashPop        GitAction = "stash-pop"
    ActionStashApply      GitAction = "stash-apply"
    ActionStashDrop       GitAction = "stash-drop"
    ActionBranchFromStash GitAction = "branch-from-stash"
    
    // Working directory
    ActionClean           GitAction = "clean"
    ActionResetHard       GitAction = "reset-hard"
)
```

### Go Implementation

```go
func (s *Server) handleGitAction(w http.ResponseWriter, r *http.Request) {
    var req struct {
        Path   string            `json:"path"`
        Action GitAction         `json:"action"`
        Params map[string]string `json:"params"`
    }
    json.NewDecoder(r.Body).Decode(&req)
    
    var err error
    switch req.Action {
    case ActionCreateBranch:
        err = createBranch(req.Path, req.Params["name"], req.Params["startPoint"])
    case ActionCheckoutBranch:
        err = checkoutBranch(req.Path, req.Params["branch"])
    case ActionDeleteBranch:
        force := req.Params["force"] == "true"
        err = deleteBranch(req.Path, req.Params["branch"], force)
    // ... etc
    }
    
    if err != nil {
        writeGitError(w, http.StatusBadRequest, err.Error())
        return
    }
    json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
```

---

## Phase 3: Git Actions Implementation

### Branch Operations

| Action | Git Command | Notes |
|--------|------------|-------|
| Create Branch | `git branch <name> [<start-point>]` | Optional checkout |
| Checkout Branch | `git checkout <branch>` | |
| Delete Branch | `git branch -d [-f] <branch>` | Force flag for unmerged |
| Rename Branch | `git branch -m <old> <new>` | |
| Push Branch | `git push [-u] [<remote>] <branch>` | Force modes |
| Pull Branch | `git pull [<remote>] [<branch>]` | |
| Fetch | `git fetch [<remote>]` | Optional prune |

### Commit Operations

| Action | Git Command | Notes |
|--------|------------|-------|
| Checkout Commit | `git checkout <hash>` | Detached HEAD warning |
| Cherry Pick | `git cherry-pick [--no-commit] [--edit] <hash>` | Record origin |
| Revert | `git revert <hash>` | Parent selection for merges |
| Drop Commit | `git rebase --onto <parent>^ <parent> <hash>` | Complex |
| Reset to Commit | `git reset --soft\|--mixed\|--hard <hash>` | Mode selection |
| Merge | `git merge <branch/commit>` | |
| Rebase | `git rebase <branch/commit>` | |

### Tag Operations

| Action | Git Command | Notes |
|--------|------------|-------|
| Add Tag | `git tag -a <name> -m <message> <hash>` | |
| Delete Tag | `git tag -d <name>` | Optional remote |
| Push Tag | `git push <remote> <tag>` | Multiple remotes |

### Stash Operations

| Action | Git Command | Notes |
|--------|------------|-------|
| Stash | `git stash [push] -m <message>` | |
| Pop | `git stash pop [--index] <selector>` | Reinstate index |
| Apply | `git stash apply [--index] <selector>` | |
| Drop | `git stash drop <selector>` | |
| Branch From | `git stash branch <name> <selector>` | |

### Working Directory

| Action | Git Command | Notes |
|--------|------------|-------|
| Clean | `git clean [-fd]` | |
| Reset Hard | `git reset --hard HEAD` | |

---

## Phase 4: Frontend Integration

### Context Menu on Commit

```tsx
// In CommitRow component
const handleContextMenu = (e: React.MouseEvent) => {
  e.preventDefault();
  setContextMenu({
    position: { x: e.clientX, y: e.clientY },
    target: { type: 'commit', hash: commit.hash }
  });
};
```

### Dialog Flow

```tsx
// Example: Create Branch
const handleCreateBranch = async (startPoint: string) => {
  const name = await showInputDialog('Branch name:');
  if (!name) return;
  
  const confirmed = await showConfirmDialog(`Create branch "${name}" from ${startPoint.slice(0, 7)}?`);
  if (!confirmed) return;
  
  await executeAction({
    action: 'create-branch',
    params: { name, startPoint }
  });
  
  refresh(); // Reload graph
};
```

### Action Execution Hook

```tsx
function useGitActions(repoPath: string) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const execute = async (action: string, params: Record<string, string>) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/git/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: repoPath, action, params })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      return data;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  };

  return { execute, loading, error };
}
```

---

## Phase 5: Uncommitted Changes

### Features

1. **Show uncommitted changes** in the graph (already partially implemented)
2. **Stash uncommitted changes** with message
3. **Clean uncommitted changes** (git clean)
4. **Reset uncommitted changes** (git reset --hard)
5. **Compare with commit** (diff between working dir and any commit)

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/git/uncommitted` | GET | Get uncommitted changes |
| `/api/git/diff-working` | GET | Diff working dir vs commit |

---

## Implementation Order

1. **Context Menu Component** (UI only, no actions yet)
2. **Dialog Component** (confirmation, input, select)
3. **Backend: /api/git/action** endpoint
4. **Branch Actions** (create, checkout, delete, rename, push, pull, fetch)
5. **Commit Actions** (checkout, cherry-pick, revert, drop, reset)
6. **Tag Actions** (add, delete, push, view details)
7. **Stash Actions** (apply, pop, drop, branch from)
8. **Working Directory** (stash, clean, reset)
9. **Uncommitted Changes View** (diff working dir)
10. **Copy to Clipboard** (hash, names)

## Files to Create/Modify

### New Files
- `pkg/server/git_actions.go` - Backend action execution
- `frontend/src/components/gitgraph/ContextMenu.tsx` - Context menu component
- `frontend/src/components/gitgraph/ActionDialog.tsx` - Dialog component
- `frontend/src/components/gitgraph/useGitActions.ts` - Action hook

### Modified Files
- `pkg/server/server.go` - Add /api/git/action route
- `pkg/server/git.go` - Add uncommitted changes endpoint
- `frontend/src/routes/GitGraphPage.tsx` - Add context menu, dialogs
- `frontend/src/components/gitgraph/GraphRenderer.tsx` - Add right-click handler
- `frontend/src/locales/en.json` - Add action labels
- `frontend/src/locales/zh_CN.json` - Add action labels

## Estimated Effort

- Phase 1 (Context Menu + Dialog): ~200 lines
- Phase 2 (Backend API): ~300 lines
- Phase 3 (Git Actions): ~500 lines
- Phase 4 (Frontend Integration): ~400 lines
- Phase 5 (Uncommitted Changes): ~200 lines

**Total: ~1600 lines of new code**
