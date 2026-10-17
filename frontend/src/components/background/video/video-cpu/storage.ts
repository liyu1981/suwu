// Origin Private File System library for the Video background.
//
// The on-disk format and machinery live in ../../opfs-library.ts; this module
// only pins the directory and the one-off migration from the old single-clip
// layout (source.bin/source.json). The 2D Lives background has its own
// directory, so the two libraries never mix.

import type { BackgroundStoredFile } from '../../types';
import {
  createOpfsLibrary,
  getFile,
  makeThumbnail,
  remove,
  sanitizeId,
  uniqueId,
  writeBlob,
} from '../../opfs-library';

const LEGACY_DATA = 'source.bin';
const LEGACY_META = 'source.json';

export type StoredVideoFile = BackgroundStoredFile;

interface VideoFileMeta {
  id: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

/** Migrate the old single-clip layout (source.bin/source.json) if present. */
async function migrateLegacy(dir: FileSystemDirectoryHandle): Promise<void> {
  const legacy = await getFile(dir, LEGACY_DATA);
  if (!legacy || legacy.size === 0) return;

  let meta: Partial<VideoFileMeta> | null = null;
  const metaFile = await getFile(dir, LEGACY_META);
  if (metaFile) {
    try {
      meta = JSON.parse(await metaFile.text()) as Partial<VideoFileMeta>;
    } catch {
      meta = null;
    }
  }

  const name = meta?.name || 'video';
  const id = await uniqueId(dir, sanitizeId(name));
  await writeBlob(dir, `${id}.bin`, legacy);
  const full: VideoFileMeta = {
    id,
    name,
    size: legacy.size,
    type: meta?.type ?? legacy.type,
    lastModified: meta?.lastModified ?? Date.now(),
  };
  await writeBlob(dir, `${id}.json`, JSON.stringify(full));

  const thumbnail = await makeThumbnail(legacy);
  if (thumbnail) await writeBlob(dir, `${id}.thumb`, thumbnail);

  await remove(dir, LEGACY_DATA);
  await remove(dir, LEGACY_META);
}

const library = createOpfsLibrary({
  directory: 'suwu-background-videos',
  migrate: migrateLegacy,
});

/** Copy a picked file into OPFS, capture a preview and return the id to store. */
export const storeVideoFile = library.storeFile;

/** List stored clips, generating any missing previews. */
export const listVideoFiles = library.list;

/** Read a stored clip as a Blob-backed `File` for mediabunny, or null. */
export const readVideoBlob = library.read;

/** Remove a stored clip and its metadata/preview. */
export const clearVideoFile = library.clear;
