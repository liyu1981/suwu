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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[min(90vw,400px)] rounded-xl border border-white/10 bg-gray-900 p-4 shadow-xl">
        <div className="mb-3 text-sm font-medium text-white/90">{t('filebrowser.uploadTitle')}</div>

        {!uploading ? (
          <>
            <div
              onClick={() => fileInputRef.current?.click()}
              className="flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-white/20 py-8 transition-colors hover:border-sky-400/50 hover:bg-white/5"
            >
              <svg className="mb-2 h-8 w-8 text-white/30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <span className="text-xs text-white/50">{t('filebrowser.clickToSelect')}</span>
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
                  <div key={file.name} className="flex items-center justify-between py-1 text-xs text-white/70">
                    <span className="truncate">{file.name}</span>
                    <span className="ml-2 shrink-0 text-white/40">{formatSize(file.size)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-xs text-white/50 hover:text-white">
                {t('filebrowser.cancel')}
              </button>
              <button
                type="button"
                onClick={uploadFiles}
                disabled={selectedFiles.length === 0}
                className="rounded bg-sky-500/20 px-3 py-1.5 text-xs text-sky-300 hover:bg-sky-500/30 disabled:opacity-50"
              >
                {t('filebrowser.upload')} ({selectedFiles.length})
              </button>
            </div>
          </>
        ) : (
          <div className="py-4">
            <div className="mb-2 text-xs text-white/60">{t('filebrowser.uploading')}: {currentFile}</div>
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full bg-sky-500 transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="mt-1 text-right text-[10px] text-white/40">{progress}%</div>
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
