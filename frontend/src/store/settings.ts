import { atomWithStorage } from 'jotai/utils';
import { DEFAULT_BACKGROUND_ID } from '../components/background/constants';
import type { BackgroundParamValue } from '../components/background/types';

export interface AutoResolveSettings {
  filebrowser: boolean;
  fileviewer: boolean;
  /** Open the port-forwarding tile when suwu forward starts — disabled by default. */
  forward: boolean;
  /** Open the git graph tile when suwu gitgraph is used — enabled by default. */
  gitgraph: boolean;
  /** Open the diff tile when suwu diff is used — enabled by default. */
  diff: boolean;
  /** Open a new Code Explorer tile when suwu code is used — enabled by default. */
  code: boolean;
}

export const autoResolveAtom = atomWithStorage<AutoResolveSettings>('suwu:auto-resolve', {
  filebrowser: true,
  fileviewer: true,
  forward: false,
  gitgraph: true,
  diff: true,
  code: true,
});

/**
 * The app-shell background the user chose in System Settings. Persisted in
 * localStorage; falls back to the default background when unset.
 */
export const backgroundAtom = atomWithStorage<string>('suwu:background', DEFAULT_BACKGROUND_ID);

/**
 * Per-background parameter overrides chosen in System Settings, keyed by
 * background id and then parameter key. Missing entries fall back to the
 * background's declared defaults (see `resolveBackgroundParams`), so adding or
 * removing a parameter never needs a migration.
 */
export const backgroundParamsAtom = atomWithStorage<
  Record<string, Record<string, BackgroundParamValue>>
>('suwu:background-params', {});

/**
 * The WebGPU background the user last selected. System Settings restores it when
 * the user re-enters the WebGPU group, so switching to a classic background and
 * back does not forget the choice. Empty until the user picks one.
 */
export const webgpuBackgroundAtom = atomWithStorage<string>('suwu:webgpu-background', '');
