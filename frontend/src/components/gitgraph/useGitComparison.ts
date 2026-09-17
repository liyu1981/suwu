import { useCallback, useEffect, useRef, useState } from 'react'
import { comparisonRequest, type Comparison, type DiffTab, type FilePatch } from './comparison'

export function useGitComparison(tab: DiffTab, active: boolean) {
  const [data, setData] = useState<Comparison | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  // Cache only a handful of small patches. Closing the tab releases everything.
  const cache = useRef(new Map<string, FilePatch>())
  useEffect(() => {
    if (!active || data) return
    const controller = new AbortController()
    setError('')
    comparisonRequest<Comparison>('compare', { path: tab.repoPath, base: tab.base, target: tab.target }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setData(result) })
      .catch(err => { if (!controller.signal.aborted) setError(String(err.message)) })
    return () => controller.abort()
  }, [tab.repoPath, tab.base, tab.target, active, data, retry])
  const loadPatch = useCallback(async (file: string, signal: AbortSignal) => {
    const cached = cache.current.get(file)
    if (cached) return cached
    const result = await comparisonRequest<FilePatch>('compare/file', { path: tab.repoPath, base: tab.base, target: tab.target, file }, signal)
    if (!signal.aborted && JSON.stringify(result).length < 256_000) {
      if (cache.current.size >= 8) cache.current.delete(cache.current.keys().next().value!)
      cache.current.set(file, result)
    }
    return result
  }, [tab.repoPath, tab.base, tab.target])
  return { data, error, retry: () => setRetry(n => n + 1), loadPatch }
}
