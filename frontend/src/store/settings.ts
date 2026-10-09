import { atomWithStorage } from 'jotai/utils';
import { DEFAULT_BACKGROUND_ID } from '../components/background/constants';
import type { BackgroundParamValue } from '../components/background/types';
import { DEFAULT_AVATAR_SETTINGS, normalizeAvatarSettings } from '../lib/avatar';
import { randomUserName } from '../lib/username';

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
 * Where the app-shell header bar is docked. Persisted in localStorage; an
 * unknown or missing value falls back to `top`.
 */
export type HeaderPosition = 'top' | 'bottom' | 'left' | 'right';

const HEADER_POSITIONS: readonly HeaderPosition[] = ['top', 'bottom', 'left', 'right'];

/** Narrow an arbitrary stored string to a known header position. */
export function isHeaderPosition(value: unknown): value is HeaderPosition {
  return typeof value === 'string' && (HEADER_POSITIONS as readonly string[]).includes(value);
}

/** The edge the header bar is docked to. Persisted in localStorage. */
export const headerPositionAtom = atomWithStorage<HeaderPosition>('suwu:header-position', 'top');

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

/**
 * The light/dark mode the file viewer tile's own day/night toolbar toggle
 * chose. Persisted in localStorage so every file viewer pane — they run in
 * same-origin iframes — reopens with the last choice; defaults to dark, the
 * mode the tile always shipped with.
 */
export type FileViewerTheme = 'light' | 'dark';

export const fileViewerThemeAtom = atomWithStorage<FileViewerTheme>(
  'suwu:fileviewer-theme',
  'dark',
);

/**
 * Where the login-dialog avatar comes from, chosen in System Settings.
 * - `builtin` — a picture bundled with the server; the default. With no
 *   explicit pick (`builtinId` empty) the picture is derived from the user
 *   name, and it also backs every unavailable/failed source.
 * - `gravatar` — the avatar registered for `email` at gravatar.com.
 * - `upload` — a picture the user picked, downscaled and stored locally.
 *
 * The former `logo` source (the Suwu logo) is gone; stored values are upgraded
 * to `builtin` on read.
 */
export type AvatarSource = 'builtin' | 'gravatar' | 'upload';

export interface AvatarSettings {
  source: AvatarSource;
  /** Built-in avatar id, or `''` to derive one from the user name. */
  builtinId: string;
  /** Email hashed for Gravatar; retained while another source is active. */
  email: string;
  /** Data URL of the uploaded picture; retained while another source is active. */
  image: string;
}

/** localStorage-backed JSON storage that normalizes legacy payloads on read. */
const avatarStorage = {
  getItem: (key: string, initialValue: AvatarSettings): AvatarSettings => {
    try {
      const raw = globalThis.localStorage?.getItem(key);
      if (raw === null || raw === undefined) return initialValue;
      return normalizeAvatarSettings(JSON.parse(raw));
    } catch {
      return initialValue;
    }
  },
  setItem: (key: string, value: AvatarSettings) => {
    try {
      globalThis.localStorage?.setItem(key, JSON.stringify(value));
    } catch {
      /* quota exceeded or storage disabled — the choice just won't persist */
    }
  },
  removeItem: (key: string) => {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

/**
 * The login-dialog avatar. Persisted in localStorage only — the email is
 * hashed in the browser for Gravatar and the image never leaves the device.
 */
export const avatarAtom = atomWithStorage<AvatarSettings>(
  'suwu:avatar',
  DEFAULT_AVATAR_SETTINGS,
  avatarStorage,
);

/** localStorage key holding the account's display name. */
export const USER_NAME_KEY = 'suwu:username';

/**
 * The account's display name: shown under the avatar on the login dialog and
 * hashed into the default built-in avatar. Seeded on first read with a
 * generated name (`randomUserName`) so a fresh install has an identity without
 * a setup step, then persisted so neither the name nor its derived avatar
 * drifts between sessions.
 */
export const userNameAtom = atomWithStorage<string>(
  USER_NAME_KEY,
  '',
  {
    getItem: (key) => {
      try {
        const raw = globalThis.localStorage?.getItem(key);
        if (raw !== null && raw !== undefined) {
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
        }
      } catch {
        /* fall through and generate a fresh name */
      }
      const generated = randomUserName();
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(generated));
      } catch {
        /* storage disabled — the generated name lasts for this session only */
      }
      return generated;
    },
    setItem: (key, value) => {
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(value));
      } catch {
        /* ignore */
      }
    },
    removeItem: (key) => {
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  },
  // Read while the atom is created, so the first login-screen frame already
  // has the name — and with it the right derived avatar — instead of briefly
  // showing an empty label under a placeholder picture.
  { getOnInit: true },
);

/**
 * Idle auto-hide for the tiling spaces, configured in System Settings. When
 * enabled, spaces hide after `minutes` without pointer or keyboard activity
 * and reappear on the next interaction — a screensaver for the work surface.
 */
export interface SpacesIdleSettings {
  enabled: boolean;
  /** Idle time in minutes before spaces are hidden. */
  minutes: number;
}

export const SPACES_IDLE_MIN_MINUTES = 1;
export const SPACES_IDLE_MAX_MINUTES = 240;
export const SPACES_IDLE_DEFAULT_MINUTES = 10;

export const spacesIdleAtom = atomWithStorage<SpacesIdleSettings>('suwu:spaces-idle', {
  enabled: false,
  minutes: SPACES_IDLE_DEFAULT_MINUTES,
});
