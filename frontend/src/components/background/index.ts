// Register in-bundle backgrounds (side-effect imports).
import './ambient-blob';
import './video';
import './2d-lives';

export { BackgroundCanvas } from './BackgroundCanvas';
export { BackgroundPreview } from './BackgroundPreview';
export { DEFAULT_BACKGROUND_ID, WEBGPU_ENGINE } from './constants';
export { getBackground, listBackgrounds } from './registry';
export {
  backgroundsRevisionAtom,
  hydrateExternalBackgrounds,
  loadExternalBackgrounds,
} from './external';
export { resolveBackgroundParams } from './params';
export type {
  BackgroundBooleanParam,
  BackgroundColorParam,
  BackgroundFileListParam,
  BackgroundLiveWallpaperPage,
  BackgroundLiveWallpaperParam,
  BackgroundLiveWallpaperProvider,
  BackgroundLiveWallpaperResult,
  BackgroundNumberParam,
  BackgroundParam,
  BackgroundParamValue,
  BackgroundSelectParam,
  BackgroundStoredFile,
  BackgroundTextParam,
} from './types';
