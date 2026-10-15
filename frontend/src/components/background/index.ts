// Register in-bundle backgrounds (side-effect imports).
import './ambient-blob';
import './video';

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
  BackgroundNumberParam,
  BackgroundParam,
  BackgroundParamValue,
  BackgroundSelectParam,
  BackgroundStoredFile,
  BackgroundTextParam,
} from './types';
