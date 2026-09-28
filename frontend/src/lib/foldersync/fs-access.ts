/**
 * File System Access API glue.
 *
 * `showDirectoryPicker` and the handle permission methods are Chromium-only
 * and are not part of the TypeScript DOM lib, so the narrow shapes we depend
 * on are declared here. Everything else (values, getFileHandle, createWritable)
 * comes from lib.dom.
 */

export interface PermissionCapableHandle {
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export type DirectoryHandle = FileSystemDirectoryHandle & PermissionCapableHandle;

interface PickerWindow {
  showDirectoryPicker?(options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: string;
  }): Promise<FileSystemDirectoryHandle>;
}

/** True when the browser can hand us a real local folder. Chromium only. */
export function supportsLocalFs(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as PickerWindow).showDirectoryPicker === 'function'
  );
}

/**
 * Opens the OS folder picker. Returns null when the user cancels.
 * Must be called from a user gesture.
 *
 * `id` is only forwarded when it fits Chromium's 32-character limit for the
 * picker id; an over-long id throws and would break the whole flow.
 */
export async function pickDirectory(id?: string): Promise<FileSystemDirectoryHandle | null> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) return null;
  const options: { id?: string; mode: 'read' | 'readwrite' } = { mode: 'readwrite' };
  if (id && id.length > 0 && id.length <= 32) options.id = id;
  try {
    return await picker.call(window, options);
  } catch (err) {
    if (isAbortError(err)) return null;
    throw err;
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export function isNotFoundError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'NotFoundError';
}

export async function queryPermission(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  const cap = handle as DirectoryHandle;
  // A browser without the permission API (or a persistent grant) is usable.
  if (typeof cap.queryPermission !== 'function') return 'granted';
  return cap.queryPermission({ mode: 'readwrite' });
}

/** Must be called from a user gesture — Chromium requires one for the prompt. */
export async function requestPermission(
  handle: FileSystemDirectoryHandle,
): Promise<PermissionState> {
  const cap = handle as DirectoryHandle;
  if (typeof cap.requestPermission !== 'function') return 'granted';
  return cap.requestPermission({ mode: 'readwrite' });
}
