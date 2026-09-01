import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getCredentials } from '../../lib/auth'

interface UploadDialogProps {
  currentPath: string
  onClose: () => void
  onUploadComplete: () => void
  onError: (msg: string) => void
  onSuccess: (msg: string) => void
}

export function UploadDialog({ currentPath, onClose, onUploadComplete, onError, onSuccess }: UploadDialogProps) {
  const { t } = useTranslation()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [currentFile, setCurrentFile] = useState('')

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    setSelectedFiles(files)
  }

  const uploadFiles = useCallback(async () => {
    if (selectedFiles.length === 0) return

    setUploading(true)
    setProgress(0)

    const totalFiles = selectedFiles.length
    let completedFiles = 0

    for (const file of selectedFiles) {
      setCurrentFile(file.name)

      const formData = new FormData()
      formData.append('path', currentPath)
      formData.append('file', file)

      try {
        const headers: Record<string, string> = {}
        const creds = getCredentials()
        if (creds) headers['Authorization'] = creds

        await fetch('/api/file/upload', {
          method: 'POST',
          headers,
          body: formData,
        }).then(async (res) => {
          if (!res.ok) {
            const data = await res.json()
            throw new Error(data.error || `HTTP ${res.status}`)
          }
        })

        completedFiles++
        setProgress(Math.round((completedFiles / totalFiles) * 100))
      } catch (e: unknown) {
        onError(e instanceof Error ? e.message : 'Upload failed')
        setUploading(false)
        return
      }
    }

    onSuccess(t('filebrowser.uploadSuccess'))
    onUploadComplete()
    setUploading(false)
    onClose()
  }, [selectedFiles, currentPath, onUploadComplete, onError, onSuccess, t, onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md">
      <div className="w-[min(90vw,400px)] rounded-2xl border border-white/[0.08] p-5 shadow-2xl menu-glass backdrop-blur-2xl">
        <div className="mb-4 text-[13px] font-semibold tracking-[-0.01em] text-white/80">{t('filebrowser.uploadTitle')}</div>

        {!uploading ? (
          <>
            <div
              onClick={() => fileInputRef.current?.click()}
              className="group flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-white/[0.10] py-8 transition-all duration-200 hover:border-sky-400/30 hover:bg-white/[0.03] active:scale-[0.99]"
            >
              <svg className="mb-2 h-8 w-8 text-white/20 transition-colors group-hover:text-sky-400/50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <span className="text-[11px] text-white/35 transition-colors group-hover:text-white/50">{t('filebrowser.clickToSelect')}</span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileSelect}
              className="hidden"
            />

            {selectedFiles.length > 0 && (
              <div className="mt-3 max-h-32 overflow-y-auto">
                {selectedFiles.map((file) => (
                  <div key={file.name} className="flex items-center justify-between py-1.5 text-[11px] text-white/60">
                    <span className="truncate tracking-[-0.01em]">{file.name}</span>
                    <span className="ml-2 shrink-0 tabular-nums text-white/30">{formatSize(file.size)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-white/40 transition-all duration-150 hover:bg-white/[0.08] hover:text-white/70 active:scale-[0.97]">
                {t('filebrowser.cancel')}
              </button>
              <button
                type="button"
                onClick={uploadFiles}
                disabled={selectedFiles.length === 0}
                className="rounded-lg bg-sky-500/15 px-3.5 py-1.5 text-xs font-medium text-sky-300/80 transition-all duration-150 hover:bg-sky-500/25 hover:text-sky-300 active:scale-[0.97] disabled:opacity-30"
              >
                {t('filebrowser.upload')} ({selectedFiles.length})
              </button>
            </div>
          </>
        ) : (
          <div className="py-4">
            <div className="mb-3 text-[11px] text-white/50">{t('filebrowser.uploading')}: {currentFile}</div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className="h-full rounded-full bg-sky-400/60 transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="mt-1.5 text-right text-[10px] tabular-nums text-white/25">{progress}%</div>
          </div>
        )}
      </div>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let size = bytes
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024
    i++
  }
  return `${i === 0 ? size : size.toFixed(1)} ${units[i]}`
}
