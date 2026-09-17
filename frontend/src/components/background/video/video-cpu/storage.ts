// Origin Private File System library for the Video background.
//
// A file picked with <input type="file"> is not persistable (the File object
// dies with the page), so chosen clips are copied here. Each entry is stored as
// `<id>.bin` plus `<id>.json` metadata and a `<id>.thumb` preview captured at
// ~2s. The renderer reads the selected id's bytes; System Settings lists them.

const DIRECTORY = 'suwu-background-videos'
const LEGACY_DATA = 'source.bin'
const LEGACY_META = 'source.json'
const THUMB_WIDTH = 160

export interface StoredVideoFile {
  id: string
  name: string
  size: number
  type: string
  lastModified: number
  thumbnail: Blob | null
}

interface VideoFileMeta {
  id: string
  name: string
  size: number
  type: string
  lastModified: number
}

/** Whether OPFS is available in this browser. */
export function isOpfsAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'
}

async function cacheDir(create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(DIRECTORY, { create })
}

async function getFile(dir: FileSystemDirectoryHandle, name: string): Promise<File | null> {
  try {
    const handle = await dir.getFileHandle(name)
    return await handle.getFile()
  } catch {
    return null
  }
}

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name)
    return true
  } catch {
    return false
  }
}

async function writeBlob(dir: FileSystemDirectoryHandle, name: string, data: Blob | string): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  await writable.write(data)
  await writable.close()
}

async function remove(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await dir.removeEntry(name)
  } catch {
    // Already gone.
  }
}

/** Build a filesystem-safe id from an original file name. */
function sanitizeId(name: string): string {
  const cleaned = name.replace(/[\\/]/g, '_').replace(/^\.+$/, '').trim()
  return cleaned || 'video'
}

/** Append " (2)", " (3)", … until the id is free. */
async function uniqueId(dir: FileSystemDirectoryHandle, base: string): Promise<string> {
  let candidate = base
  let counter = 2
  while (await exists(dir, `${candidate}.json`)) {
    candidate = `${base} (${counter++})`
  }
  return candidate
}

/** Grab a frame at ~2s and encode it as a small WebP preview. */
async function makeThumbnail(blob: Blob): Promise<Blob | null> {
  if (typeof document === 'undefined') return null
  const url = URL.createObjectURL(blob)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.src = url
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const done = () => {
        if (!settled) {
          settled = true
          resolve()
        }
      }
      video.onloadeddata = done
      video.onerror = () => {
        if (!settled) {
          settled = true
          reject(new Error('preview decode failed'))
        }
      }
      window.setTimeout(done, 5000)
    })

    const duration = Number.isFinite(video.duration) ? video.duration : 0
    const target = duration > 2 ? 2 : 0
    if (target > 0) {
      video.currentTime = target
      await new Promise<void>((resolve) => {
        let settled = false
        const done = () => {
          if (!settled) {
            settled = true
            resolve()
          }
        }
        video.onseeked = done
        window.setTimeout(done, 3000)
      })
    }

    // Dimensions occasionally lag a tick behind `loadeddata`.
    for (let attempt = 0; attempt < 5 && (!video.videoWidth || !video.videoHeight); attempt++) {
      await new Promise((resolve) => window.setTimeout(resolve, 50))
    }
    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) return null

    const canvas = document.createElement('canvas')
    canvas.width = Math.min(THUMB_WIDTH, width)
    canvas.height = Math.max(1, Math.round((canvas.width * height) / width))
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(video, 0, 0, canvas.width, canvas.height)

    const encode = (type: string, quality?: number) =>
      new Promise<Blob | null>((resolve) => canvas.toBlob((result) => resolve(result), type, quality))
    return (await encode('image/webp', 0.7)) ?? (await encode('image/png'))
  } catch {
    return null
  } finally {
    video.src = ''
    URL.revokeObjectURL(url)
  }
}

/** Migrate the old single-clip layout (source.bin/source.json) if present. */
let migration: Promise<void> | null = null

function ensureMigrated(dir: FileSystemDirectoryHandle): Promise<void> {
  if (!migration) {
    migration = migrateLegacy(dir).catch(() => undefined)
  }
  return migration
}

async function migrateLegacy(dir: FileSystemDirectoryHandle): Promise<void> {
  const legacy = await getFile(dir, LEGACY_DATA)
  if (!legacy || legacy.size === 0) return

  let meta: Partial<VideoFileMeta> | null = null
  const metaFile = await getFile(dir, LEGACY_META)
  if (metaFile) {
    try {
      meta = JSON.parse(await metaFile.text()) as Partial<VideoFileMeta>
    } catch {
      meta = null
    }
  }

  const name = meta?.name || 'video'
  const id = await uniqueId(dir, sanitizeId(name))
  await writeBlob(dir, `${id}.bin`, legacy)
  const full: VideoFileMeta = {
    id,
    name,
    size: legacy.size,
    type: meta?.type ?? legacy.type,
    lastModified: meta?.lastModified ?? Date.now(),
  }
  await writeBlob(dir, `${id}.json`, JSON.stringify(full))

  const thumbnail = await makeThumbnail(legacy)
  if (thumbnail) await writeBlob(dir, `${id}.thumb`, thumbnail)

  await remove(dir, LEGACY_DATA)
  await remove(dir, LEGACY_META)
}

/**
 * Copy a picked file into OPFS, capture a preview and return the id to store
 * in the parameter.
 */
export async function storeVideoFile(file: File): Promise<string> {
  if (!isOpfsAvailable()) {
    throw new Error('This browser does not support OPFS storage.')
  }
  const dir = await cacheDir(true)
  const id = await uniqueId(dir, sanitizeId(file.name))
  await writeBlob(dir, `${id}.bin`, file)
  const meta: VideoFileMeta = {
    id,
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
  }
  await writeBlob(dir, `${id}.json`, JSON.stringify(meta))

  const thumbnail = await makeThumbnail(file)
  if (thumbnail) await writeBlob(dir, `${id}.thumb`, thumbnail)
  return id
}

/** List stored clips, generating any missing previews. */
export async function listVideoFiles(): Promise<StoredVideoFile[]> {
  if (!isOpfsAvailable()) return []

  let dir: FileSystemDirectoryHandle
  try {
    dir = await cacheDir(true)
  } catch {
    return []
  }
  await ensureMigrated(dir)

  const entries: StoredVideoFile[] = []
  for await (const handle of dir.values()) {
    if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue
    const metaFile = await getFile(dir, handle.name)
    if (!metaFile) continue
    let meta: VideoFileMeta
    try {
      meta = JSON.parse(await metaFile.text()) as VideoFileMeta
    } catch {
      continue
    }
    const id = handle.name.slice(0, -'.json'.length)
    entries.push({
      id,
      name: meta.name || id,
      size: meta.size ?? 0,
      type: meta.type ?? '',
      lastModified: meta.lastModified ?? 0,
      thumbnail: await getFile(dir, `${id}.thumb`),
    })
  }

  // Backfill previews for entries added before thumbnails existed.
  for (const entry of entries) {
    if (entry.thumbnail) continue
    const data = await getFile(dir, `${entry.id}.bin`)
    if (!data) continue
    const thumbnail = await makeThumbnail(data)
    if (thumbnail) {
      await writeBlob(dir, `${entry.id}.thumb`, thumbnail)
      entry.thumbnail = thumbnail
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries
}

/** Read a stored clip as a Blob-backed `File` for mediabunny, or null. */
export async function readVideoBlob(id: string): Promise<File | null> {
  if (!id || !isOpfsAvailable()) return null
  try {
    const dir = await cacheDir(false)
    await ensureMigrated(dir)
    return await getFile(dir, `${id}.bin`)
  } catch {
    return null
  }
}

/** Remove a stored clip and its metadata/preview. */
export async function clearVideoFile(id: string): Promise<void> {
  if (!id || !isOpfsAvailable()) return
  try {
    const dir = await cacheDir(false)
    await remove(dir, `${id}.bin`)
    await remove(dir, `${id}.json`)
    await remove(dir, `${id}.thumb`)
  } catch {
    // Nothing stored.
  }
}
