// Origin Private File System cache for the Video background.
//
// A file picked with <input type="file"> is not persistable (the File object
// dies with the page and can't live in localStorage), so the chosen clip is
// copied here. The renderer reads it back on every start. One clip is kept:
// picking a new file overwrites it.

const DIRECTORY = 'suwu-background-videos'
const DATA_FILE = 'source.bin'
const META_FILE = 'source.json'

interface VideoFileMeta {
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

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Blob | string): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  await writable.write(data)
  await writable.close()
}

/**
 * Copy a picked file into OPFS. Returns the value stored in the param (the
 * original file name, shown in System Settings).
 */
export async function storeVideoFile(file: File): Promise<string> {
  if (!isOpfsAvailable()) {
    throw new Error('This browser does not support OPFS storage.')
  }
  const dir = await cacheDir(true)
  await writeFile(dir, DATA_FILE, file)
  const meta: VideoFileMeta = {
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
  }
  await writeFile(dir, META_FILE, JSON.stringify(meta))
  return file.name
}

/** Read the cached clip bytes, or null when nothing has been stored. */
export async function readVideoFile(): Promise<ArrayBuffer | null> {
  if (!isOpfsAvailable()) return null
  try {
    const dir = await cacheDir(false)
    const handle = await dir.getFileHandle(DATA_FILE)
    const file = await handle.getFile()
    if (file.size === 0) return null
    return await file.arrayBuffer()
  } catch {
    return null
  }
}

/** Remove the cached clip. */
export async function clearVideoFile(): Promise<void> {
  if (!isOpfsAvailable()) return
  try {
    const dir = await cacheDir(false)
    await dir.removeEntry(DATA_FILE)
    await dir.removeEntry(META_FILE)
  } catch {
    // Nothing cached.
  }
}
