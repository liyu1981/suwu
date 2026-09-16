// Register built-in backgrounds (side-effect imports).
import './ambient-blob'
import './interactive-fluid'
import './matrix-rain'
import './atmospheric-landscape'
import './seascape'

export { AmbientBackground, type AmbientBackgroundProps } from './AmbientBackground'
export { DEFAULT_BACKGROUND_ID } from './constants'
export { startBackground, type StartBackgroundOptions } from './select'
export { getBackground, listBackgrounds, registerBackground } from './registry'
export {
  defaultBackgroundParams,
  resolveBackgroundParams,
} from './params'
export type {
  BackendKind,
  BackgroundBooleanParam,
  BackgroundContext,
  BackgroundDefinition,
  BackgroundHandle,
  BackgroundModule,
  BackgroundNumberParam,
  BackgroundParam,
  BackgroundParamValue,
  BackgroundSelectOption,
  BackgroundSelectParam,
  BackgroundStarter,
} from './types'
