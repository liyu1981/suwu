import type { PaneItem } from './api';

/**
 * Local filesystem access for the "this browser" left-pane mode, using the
 * File System Access API (Chromium). When it is unavailable the tile falls back
 * to the Suwu host tree.
 */

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      mode?: 'read' | 'readwrite';
    }) => Promise<FileSystemDirectoryHandle>;
  }
}

/** Whether the browser can open and write a local directory. */
export function browserFsSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/** Prompt the user to choose a local directory. */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!window.showDirectoryPicker) {
    throw new Error('This browser cannot open a local folder.');
  }
  return window.showDirectoryPicker({ mode: 'readwrite' });
}

/** List a browser directory as PaneItems. */
export async function listBrowserDir(handle: FileSystemDirectoryHandle): Promise<PaneItem[]> {
  const items: PaneItem[] = [];
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind === 'directory') {
      items.push({ name, isDir: true, size: 0, modTime: '' });
    } else {
      const file = await entry.getFile();
      items.push({
        name,
        isDir: false,
        size: file.size,
        modTime: new Date(file.lastModified).toISOString(),
      });
    }
  }
  items.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return items;
}

export function getBrowserDir(
  handle: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle> {
  return handle.getDirectoryHandle(name);
}

export async function getBrowserFile(
  handle: FileSystemDirectoryHandle,
  name: string,
): Promise<File> {
  const fileHandle = await handle.getFileHandle(name);
  return fileHandle.getFile();
}

export async function writeBrowserFile(
  handle: FileSystemDirectoryHandle,
  name: string,
  blob: Blob,
): Promise<void> {
  const fileHandle = await handle.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

export async function makeBrowserDir(
  handle: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  await handle.getDirectoryHandle(name, { create: true });
}

export async function removeBrowserEntry(
  handle: FileSystemDirectoryHandle,
  name: string,
  isDir: boolean,
): Promise<void> {
  await handle.removeEntry(name, { recursive: isDir });
}
