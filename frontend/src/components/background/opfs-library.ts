import type { BackgroundStoredFile } from './types';

/**
 * Shared Origin Private File System library used by the video-backed
 * backgrounds.
 *
 * Each family owns one directory (`createOpfsLibrary({ directory })`) so the
 * Video clip library and the 2D Lives wallpaper library never mix, but the
 * on-disk format and the machinery are identical: an entry is `<id>.bin` plus
 * `<id>.json` metadata and a `<id>.thumb` preview. The renderer reads the
 * selected id's bytes; System Settings lists them.
 *
 * The low-level helpers are exported so a family can implement its own one-off
 * migration over the raw directory handle.
 */

/** Width of the generated preview, in pixels. */
const THUMB_WIDTH = 160;

/** Whether OPFS is available in this browser. */
export function isOpfsAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
}

/** Open (optionally create) a named directory under the OPFS root. */
export async function openCacheDir(
  directory: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(directory, { create });
}

export async function getFile(dir: FileSystemDirectoryHandle, name: string): Promise<File | null> {
  try {
    const handle = await dir.getFileHandle(name);
    return await handle.getFile();
  } catch {
    return null;
  }
}

export async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

export async function writeBlob(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: Blob | string,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

export async function remove(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await dir.removeEntry(name);
  } catch {
    // Already gone.
  }
}

/** Build a filesystem-safe id from an original file name. */
export function sanitizeId(name: string): string {
  const cleaned = name.replace(/[\\/]/g, '_').replace(/^\.+$/, '').trim();
  return cleaned || 'clip';
}

/** Append " (2)", " (3)", … until the id is free. */
export async function uniqueId(dir: FileSystemDirectoryHandle, base: string): Promise<string> {
  let candidate = base;
  let counter = 2;
  while (await exists(dir, `${candidate}.json`)) {
    candidate = `${base} (${counter++})`;
  }
  return candidate;
}

/** Grab a frame at ~2s and encode it as a small WebP preview. */
export async function makeThumbnail(blob: Blob): Promise<Blob | null> {
  if (typeof document === 'undefined') return null;
  const url = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      video.onloadeddata = done;
      video.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error('preview decode failed'));
        }
      };
      window.setTimeout(done, 5000);
    });

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const target = duration > 2 ? 2 : 0;
    if (target > 0) {
      video.currentTime = target;
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        video.onseeked = done;
        window.setTimeout(done, 3000);
      });
    }

    // Dimensions occasionally lag a tick behind `loadeddata`.
    for (let attempt = 0; attempt < 5 && (!video.videoWidth || !video.videoHeight); attempt++) {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;

    const canvas = document.createElement('canvas');
    canvas.width = Math.min(THUMB_WIDTH, width);
    canvas.height = Math.max(1, Math.round((canvas.width * height) / width));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const encode = (type: string, quality?: number) =>
      new Promise<Blob | null>((resolve) =>
        canvas.toBlob((result) => resolve(result), type, quality),
      );
    return (await encode('image/webp', 0.7)) ?? (await encode('image/png'));
  } catch {
    return null;
  } finally {
    video.src = '';
    URL.revokeObjectURL(url);
  }
}

/** Stored entry shape; identical for every family. */
export type StoredOpfsFile = BackgroundStoredFile;

/** One family's OPFS library. */
export interface OpfsLibrary {
  /** Copy a user-picked file in, capture a preview and return its id. */
  storeFile(file: File): Promise<string>;
  /** Stream a download in without buffering it, capture a preview, return id. */
  storeStream(stream: ReadableStream<Uint8Array>, name: string, type: string): Promise<string>;
  /** List stored entries (with thumbnails), generating any missing previews. */
  list(): Promise<StoredOpfsFile[]>;
  /** Read a stored entry as a Blob-backed `File`, or null. */
  read(id: string): Promise<File | null>;
  /** Remove an entry and its metadata/preview. */
  clear(id: string): Promise<void>;
  /** Raw directory handle, for a family-specific migration. */
  directory(create: boolean): Promise<FileSystemDirectoryHandle>;
}

export interface OpfsLibraryOptions {
  /** Directory name under the OPFS root. */
  directory: string;
  /**
   * One-off migration run lazily before the first list/read. It receives the
   * family's directory handle and may rewrite old layouts with the exported
   * helpers. Failures are swallowed (the library keeps working).
   */
  migrate?: (dir: FileSystemDirectoryHandle) => Promise<void>;
}

/**
 * Create a directory-backed OPFS library. The only state is a lazily-resolved
 * migration promise, so two families are fully independent.
 */
export function createOpfsLibrary({ directory, migrate }: OpfsLibraryOptions): OpfsLibrary {
  let migration: Promise<void> | null = null;

  const dirHandle = (create: boolean): Promise<FileSystemDirectoryHandle> =>
    openCacheDir(directory, create);

  const ensureMigrated = (dir: FileSystemDirectoryHandle): Promise<void> => {
    if (!migrate) return Promise.resolve();
    if (!migration) migration = migrate(dir).catch(() => undefined);
    return migration;
  };

  const storeFile = async (file: File): Promise<string> => {
    if (!isOpfsAvailable()) {
      throw new Error('This browser does not support OPFS storage.');
    }
    const dir = await dirHandle(true);
    const id = await uniqueId(dir, sanitizeId(file.name));
    await writeBlob(dir, `${id}.bin`, file);
    await writeBlob(
      dir,
      `${id}.json`,
      JSON.stringify({
        id,
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
      }),
    );

    const thumbnail = await makeThumbnail(file);
    if (thumbnail) await writeBlob(dir, `${id}.thumb`, thumbnail);
    return id;
  };

  const storeStream = async (
    stream: ReadableStream<Uint8Array>,
    name: string,
    type: string,
  ): Promise<string> => {
    if (!isOpfsAvailable()) {
      throw new Error('This browser does not support OPFS storage.');
    }
    const dir = await dirHandle(true);
    const id = await uniqueId(dir, sanitizeId(name));
    const binName = `${id}.bin`;
    try {
      const handle = await dir.getFileHandle(binName, { create: true });
      const writable = await handle.createWritable();
      await stream.pipeTo(writable);
    } catch (error) {
      // Quota or network failure: never keep a half-written entry.
      await remove(dir, binName);
      throw error;
    }

    const data = await getFile(dir, binName);
    const resolvedType = type || data?.type || 'video/mp4';
    await writeBlob(
      dir,
      `${id}.json`,
      JSON.stringify({
        id,
        name,
        size: data?.size ?? 0,
        type: resolvedType,
        lastModified: Date.now(),
      }),
    );

    if (data) {
      // An OPFS `.bin` file carries no useful MIME type, so re-wrap it (a Blob
      // built from a Blob references the same bytes — nothing is copied) before
      // the <video> element tries to decode it.
      const thumbnail = await makeThumbnail(new Blob([data], { type: resolvedType }));
      if (thumbnail) await writeBlob(dir, `${id}.thumb`, thumbnail);
    }
    return id;
  };

  const list = async (): Promise<StoredOpfsFile[]> => {
    if (!isOpfsAvailable()) return [];

    let dir: FileSystemDirectoryHandle;
    try {
      dir = await dirHandle(true);
    } catch {
      return [];
    }
    await ensureMigrated(dir);

    const entries: StoredOpfsFile[] = [];
    for await (const handle of dir.values()) {
      if (handle.kind !== 'file' || !handle.name.endsWith('.json')) continue;
      const metaFile = await getFile(dir, handle.name);
      if (!metaFile) continue;
      let meta: Partial<StoredOpfsFile>;
      try {
        meta = JSON.parse(await metaFile.text()) as Partial<StoredOpfsFile>;
      } catch {
        continue;
      }
      const id = handle.name.slice(0, -'.json'.length);
      entries.push({
        id,
        name: meta.name || id,
        size: meta.size ?? 0,
        type: meta.type ?? '',
        lastModified: meta.lastModified ?? 0,
        thumbnail: await getFile(dir, `${id}.thumb`),
      });
    }

    // Backfill previews for entries added before thumbnails existed.
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.thumbnail) continue;
      const data = await getFile(dir, `${entry.id}.bin`);
      if (!data) continue;
      const thumbnail = await makeThumbnail(new Blob([data], { type: entry.type }));
      if (thumbnail) {
        await writeBlob(dir, `${entry.id}.thumb`, thumbnail);
        entries[i] = { ...entry, thumbnail };
      }
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  };

  const read = async (id: string): Promise<File | null> => {
    if (!id || !isOpfsAvailable()) return null;
    try {
      const dir = await dirHandle(false);
      await ensureMigrated(dir);
      return await getFile(dir, `${id}.bin`);
    } catch {
      return null;
    }
  };

  const clear = async (id: string): Promise<void> => {
    if (!id || !isOpfsAvailable()) return;
    try {
      const dir = await dirHandle(false);
      await remove(dir, `${id}.bin`);
      await remove(dir, `${id}.json`);
      await remove(dir, `${id}.thumb`);
    } catch {
      // Nothing stored.
    }
  };

  return { storeFile, storeStream, list, read, clear, directory: dirHandle };
}
