import { useCallback, useState } from 'react'
import { authFetch } from '../../lib/api'

export type GitAction =
  | 'create-branch' | 'checkout-branch' | 'delete-branch' | 'rename-branch'
  | 'push-branch' | 'pull-branch' | 'fetch'
  | 'checkout-commit' | 'cherry-pick' | 'revert' | 'reset-to-commit'
  | 'merge' | 'rebase' | 'drop-commit'
  | 'add-tag' | 'delete-tag' | 'push-tag'
  | 'stash' | 'stash-pop' | 'stash-apply' | 'stash-drop' | 'branch-from-stash'
  | 'clean' | 'reset-hard'

export interface UseGitActionsReturn {
  execute: (action: GitAction, params?: Record<string, string>) => Promise<void>
  loading: boolean
  error: string | null
  clearError: () => void
}

/**
 * Hook for executing git actions via POST /api/git/action.
 * Returns an execute function, loading state, and error.
 */
export function useGitActions(repoPath: string): UseGitActionsReturn {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const execute = useCallback(async (action: GitAction, params: Record<string, string> = {}) => {
    setLoading(true)
    setError(null)
    try {
      const res = await authFetch('/api/git/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ path: repoPath, action, params }),
      })

      const data = await res.json().catch(() => ({ error: 'Failed to parse response' }))

      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Action failed'
      setError(msg)
      throw err
    } finally {
      setLoading(false)
    }
  }, [repoPath])

  return { execute, loading, error, clearError: () => setError(null) }
}
