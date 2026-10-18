import type { BackgroundParam } from '../types';
import { VIDEO_PLAYBACK_PARAMS, VIDEO_ROTATE_MINUTES_DEFAULT } from '../video/params';
import {
  downloadLiveWallpaper,
  listLiveWallpaperProviders,
  searchLiveWallpapers,
} from './providers';
import { clearLiveFile, listLiveFiles } from './storage';

/**
 * Parameters for the 2D Lives background: a remote wallpaper browser plus the
 * shared playback controls.
 *
 * The library is the wallpaper-only OPFS directory (./storage.ts), so downloads
 * here never appear in the Video clip picker and vice versa. The playback
 * parameters are shared with Video verbatim, minus the **Smooth loop** switch:
 * wallpapers are authored to loop, so the crossfade is unnecessary. The source
 * is the only other difference, which is what lets both families run the same
 * renderer.
 *
 * **Auto rotate** cycles through every downloaded wallpaper on a timer; the
 * renderer reads the library through its `listSources` option.
 */
export const LIVES_PARAMS: readonly BackgroundParam[] = [
  {
    kind: 'liveWallpapers',
    key: 'source',
    label: '2D live wallpaper',
    hint: 'Search, then download a wallpaper into this browser. Files stay on this device.',
    default: '',
    providers: listLiveWallpaperProviders,
    search: searchLiveWallpapers,
    download: downloadLiveWallpaper,
    list: listLiveFiles,
    clear: clearLiveFile,
  },
  {
    kind: 'boolean',
    key: 'rotate',
    label: 'Auto rotate',
    hint: 'Cycle through every downloaded wallpaper.',
    default: false,
  },
  {
    kind: 'number',
    key: 'rotateMinutes',
    label: 'Rotate every',
    default: VIDEO_ROTATE_MINUTES_DEFAULT,
    min: 1,
    max: 120,
    step: 1,
    format: (value) => `${value} min`,
  },
  ...VIDEO_PLAYBACK_PARAMS.filter((param) => param.key !== 'crossfade'),
];
