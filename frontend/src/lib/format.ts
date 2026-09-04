/** Shared formatting utilities used across plugin pages. */

import { getCredentials } from './auth'

export function formatSize(bytes: number): string {
  if (bytes === 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024
    i++
  }
  return `${i === 0 ? size : size.toFixed(1)} ${units[i]}`
}

export function formatDate(iso: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const d = new Date(iso)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const day = 86400000
  if (diff < day) return t('filebrowser.today')
  if (diff < day * 2) return t('filebrowser.yesterday')
  if (diff < day * 7) return t('filebrowser.daysAgo', { count: Math.floor(diff / day) })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined })
}

export function relativeTime(iso: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return t('notifications.justNow')
  const min = Math.floor(sec / 60)
  if (min < 60) return t('notifications.minutesAgo', { count: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('notifications.hoursAgo', { count: hr })
  const d = Math.floor(hr / 24)
  return t('notifications.daysAgo', { count: d })
}

export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().trim()
  return h === '' || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0'
}

/** Generic JSON fetcher with auth header support. */
export async function fetchJson<T>(url: string): Promise<T> {
  const headers: Record<string, string> = {}
  const creds = getCredentials()
  if (creds) headers['Authorization'] = creds
  const res = await fetch(url, { cache: 'no-store', headers })
  let data: (T & { error?: string }) | null = null
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
  return data as T
}
