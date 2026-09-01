import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getCredentials } from '../../lib/auth'

interface FileEntry {
  name: string
  isDir: boolean
  size: number
  modTime: string
}

interface ContextMenuProps {
  x: number
  y: number
  entry: FileEntry | null
  currentPath: string
  onClose: () => void
  onRefresh: () => void
  onError: (msg: string) => void
  onSuccess: (msg: string) => void
  openInViewer: (path: string) => void
  onUpload: () => void
  onNewFolder: () => void
}

const MAX_VIEWER_SIZE = 100 * 1024 * 1024 // 100MB

export function ContextMenu({
  x,
  y,
  entry,
  currentPath,
  onClose,
  onRefresh,
  onError,
  onSuccess,
  openInViewer,
  onUpload,
  onNewFolder: _onNewFolder,
}: ContextMenuProps) {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement>(null)
  const [showRename, setShowRename] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [newFolderName, setNewFolderName] = useState('')
  const [loading, setLoading] = useState(false)

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [onClose])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Adjust position to stay within viewport
  useEffect(() => {
    if (!menuRef.current) return
    const rect = menuRef.current.getBoundingClientRect()
    const padding = 8
    if (rect.right > window.innerWidth - padding) {
      menuRef.current.style.left = `${window.innerWidth - rect.width - padding}px`
    }
    if (rect.bottom > window.innerHeight - padding) {
      menuRef.current.style.top = `${window.innerHeight - rect.height - padding}px`
    }
  }, [])

  const fullPath = entry ? `${currentPath}/${entry.name}`.replace(/\/+/g, '/') : currentPath

  const apiCall = useCallback(async (url: string, body: unknown) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    const creds = getCredentials()
    if (creds) headers['Authorization'] = creds

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    return data
  }, [])

  const handleRename = async () => {
    if (!entry || !renameValue.trim()) return
    setLoading(true)
    try {
      await apiCall('/api/file/rename', { path: fullPath, newName: renameValue.trim() })
      onSuccess(t('filebrowser.renameSuccess'))
      onRefresh()
      onClose()
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : 'Rename failed')
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async () => {
    if (!entry) return
    setLoading(true)
    try {
      await apiCall('/api/file/delete', { path: fullPath })
      onSuccess(t('filebrowser.deleteSuccess'))
      onRefresh()
      onClose()
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setLoading(false)
    }
  }

  const handleViewInViewer = () => {
    if (!entry) return
    if (entry.size > MAX_VIEWER_SIZE) {
      onError(t('filebrowser.fileTooLarge'))
      onClose()
      return
    }
    openInViewer(fullPath)
    onClose()
  }

  const handleDownload = async () => {
    if (!entry) return
    setLoading(true)
    try {
      const headers: Record<string, string> = {}
      const creds = getCredentials()
      if (creds) headers['Authorization'] = creds

      const res = await fetch(`/api/file?path=${encodeURIComponent(fullPath)}&download=true`, {
        cache: 'no-store',
        headers,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error || `HTTP ${res.status}`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = entry.name
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      onClose()
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : 'Download failed')
    } finally {
      setLoading(false)
    }
  }

  const handleNewFolder = async () => {
    if (!newFolderName.trim()) return
    setLoading(true)
    try {
      const newPath = `${fullPath}/${newFolderName.trim()}`.replace(/\/+/g, '/')
      await apiCall('/api/file/mkdir', { path: newPath })
      onSuccess(t('filebrowser.newFolderSuccess'))
      onRefresh()
      onClose()
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : 'Failed to create folder')
    } finally {
      setLoading(false)
    }
  }

  // New Folder dialog
  if (showNewFolder) {
    return (
      <div
        ref={menuRef}
        className="fixed z-50 w-[280px] rounded-xl border border-white/10 p-3 shadow-2xl backdrop-blur-xl"
        style={{
          left: x,
          top: y,
          background: 'rgba(30, 30, 30, 0.85)',
        }}
      >
        <div className="mb-2 text-xs font-medium text-white/80">{t('filebrowser.newFolderTitle')}</div>
        <input
          type="text"
          value={newFolderName}
          onChange={(e) => setNewFolderName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleNewFolder()}
          className="mb-3 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white outline-none transition-colors focus:border-sky-400/50 focus:bg-white/10"
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-xs text-white/50 transition-colors hover:bg-white/10 hover:text-white"
          >
            {t('filebrowser.cancel')}
          </button>
          <button
            type="button"
            onClick={handleNewFolder}
            disabled={loading || !newFolderName.trim()}
            className="rounded-lg bg-sky-500/20 px-3 py-1.5 text-xs text-sky-300 transition-colors hover:bg-sky-500/30 disabled:opacity-50"
          >
            {t('filebrowser.confirm')}
          </button>
        </div>
      </div>
    )
  }

  // Rename dialog
  if (showRename) {
    return (
      <div
        ref={menuRef}
        className="fixed z-50 w-[280px] rounded-xl border border-white/10 p-3 shadow-2xl backdrop-blur-xl"
        style={{
          left: x,
          top: y,
          background: 'rgba(30, 30, 30, 0.85)',
        }}
      >
        <div className="mb-2 text-xs font-medium text-white/80">{t('filebrowser.renameTitle')}</div>
        <input
          type="text"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleRename()}
          className="mb-3 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white outline-none transition-colors focus:border-sky-400/50 focus:bg-white/10"
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-xs text-white/50 transition-colors hover:bg-white/10 hover:text-white"
          >
            {t('filebrowser.cancel')}
          </button>
          <button
            type="button"
            onClick={handleRename}
            disabled={loading || !renameValue.trim()}
            className="rounded-lg bg-sky-500/20 px-3 py-1.5 text-xs text-sky-300 transition-colors hover:bg-sky-500/30 disabled:opacity-50"
          >
            {t('filebrowser.confirm')}
          </button>
        </div>
      </div>
    )
  }

  // Delete dialog
  if (showDelete && entry) {
    return (
      <div
        ref={menuRef}
        className="fixed z-50 w-[280px] rounded-xl border border-white/10 p-3 shadow-2xl backdrop-blur-xl"
        style={{
          left: x,
          top: y,
          background: 'rgba(30, 30, 30, 0.85)',
        }}
      >
        <div className="mb-2 text-xs font-medium text-white/80">{t('filebrowser.deleteTitle')}</div>
        <div className="mb-3 text-[11px] leading-relaxed text-white/60">
          {t('filebrowser.deleteConfirm', { name: entry.name })}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-xs text-white/50 transition-colors hover:bg-white/10 hover:text-white"
          >
            {t('filebrowser.cancel')}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={loading}
            className="rounded-lg bg-red-500/20 px-3 py-1.5 text-xs text-red-300 transition-colors hover:bg-red-500/30 disabled:opacity-50"
          >
            {t('filebrowser.delete')}
          </button>
        </div>
      </div>
    )
  }

  // Main context menu
  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[180px] overflow-hidden rounded-xl border border-white/10 py-1 shadow-2xl backdrop-blur-xl"
      style={{
        left: x,
        top: y,
        background: 'rgba(30, 30, 30, 0.85)',
      }}
    >
      <MenuItem
        label={t('filebrowser.contextMenu.newFolder')}
        icon={<NewFolderIcon />}
        onClick={() => {
          setNewFolderName('')
          setShowNewFolder(true)
        }}
      />
      {entry && (
        <>
          <MenuDivider />
          <MenuItem
            label={t('filebrowser.contextMenu.rename')}
            icon={<RenameIcon />}
            onClick={() => { setRenameValue(entry.name); setShowRename(true) }}
          />
          <MenuItem
            label={t('filebrowser.contextMenu.delete')}
            icon={<DeleteIcon />}
            onClick={() => setShowDelete(true)}
            danger
          />
        </>
      )}
      <MenuDivider />
      <MenuItem
        label={t('filebrowser.contextMenu.upload')}
        icon={<UploadIcon />}
        onClick={() => { onUpload(); onClose() }}
      />
      {entry && !entry.isDir && (
        <>
          <MenuDivider />
          <MenuItem
            label={t('filebrowser.contextMenu.viewInViewer')}
            icon={<ViewIcon />}
            onClick={handleViewInViewer}
          />
          <MenuItem
            label={t('filebrowser.contextMenu.download')}
            icon={<DownloadIcon />}
            onClick={handleDownload}
          />
        </>
      )}
    </div>
  )
}

function MenuItem({
  label,
  icon,
  onClick,
  danger = false,
}: {
  label: string
  icon?: React.ReactNode
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${
        danger
          ? 'text-red-400 hover:bg-red-500/10'
          : 'text-white/80 hover:bg-white/10'
      }`}
    >
      {icon && <span className="w-4 shrink-0 opacity-60">{icon}</span>}
      {label}
    </button>
  )
}

function MenuDivider() {
  return <div className="my-1 border-t border-white/10" />
}

// ── Icons ──

function RenameIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  )
}

function DeleteIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

function UploadIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  )
}

function ViewIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

function NewFolderIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  )
}
