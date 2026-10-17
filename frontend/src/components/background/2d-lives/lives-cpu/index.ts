import { createVideoBackground } from '../../video/video-cpu/renderer';
import { readLiveBlob } from '../storage';

/**
 * 2D Lives CPU backend: the shared video renderer reading from the wallpaper
 * library (never the Video clip library), with wallpaper-appropriate
 * empty-state copy. Wallpapers are authored to loop, so the crossfade switch
 * is not exposed for this family.
 */
export const start = createVideoBackground({
  readSource: readLiveBlob,
  title: '2D Lives',
  emptyHint: 'Search and download a wallpaper in System Settings.',
  missingHint: 'Download it again in System Settings.',
});
