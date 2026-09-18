// Register built-in backgrounds (side-effect imports).
import './ambient-blob';
import './video';
import './webgpu';

export { BackgroundCanvas, type BackgroundCanvasProps } from './BackgroundCanvas';
export { BackgroundPreview, type BackgroundPreviewProps } from './BackgroundPreview';
export { fitPreviewBox } from './preview-size';
export { DEFAULT_BACKGROUND_ID, WEBGPU_ENGINE } from './constants';
export { startBackground, type StartBackgroundOptions } from './select';
export { getBackground, listBackgrounds, registerBackground } from './registry';
export {
  defaultBackgroundParams,
  resolveBackgroundParams,
} from './params';
export type {
  BackendKind,
  BackgroundBooleanParam,
  BackgroundColorParam,
  BackgroundContext,
  BackgroundCredit,
  BackgroundDefinition,
  BackgroundEngine,
  BackgroundFileListParam,
  BackgroundHandle,
  BackgroundModule,
  BackgroundNumberParam,
  BackgroundParam,
  BackgroundParamValue,
  BackgroundSelectOption,
  BackgroundSelectParam,
  BackgroundStarter,
  BackgroundStoredFile,
  BackgroundTextParam,
} from './types';
