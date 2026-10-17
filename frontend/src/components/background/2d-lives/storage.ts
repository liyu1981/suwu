// Origin Private File System library for the 2D Lives background.
//
// Same on-disk format as the Video library (see ../opfs-library.ts) but its own
// directory, so a wallpaper downloaded here never appears in the Video clip
// picker and vice versa. There is no picker/migration: entries arrive only from
// a provider download.

import { createOpfsLibrary } from '../opfs-library';

const library = createOpfsLibrary({ directory: 'suwu-background-2d-lives' });

/** Stream a downloaded wallpaper into OPFS and return the id to store. */
export const storeLiveStream = library.storeStream;

/** List downloaded wallpapers, generating any missing previews. */
export const listLiveFiles = library.list;

/** Read a downloaded wallpaper as a Blob-backed `File`, or null. */
export const readLiveBlob = library.read;

/** Remove a downloaded wallpaper and its metadata/preview. */
export const clearLiveFile = library.clear;
