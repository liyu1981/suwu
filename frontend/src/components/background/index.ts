// Register built-in backgrounds (side-effect imports).
import './ambient-blob'
import './interactive-fluid'

export { AmbientBackground, type AmbientBackgroundProps } from './AmbientBackground'
export { startBackground, type StartBackgroundOptions } from './select'
export { getBackground, listBackgrounds, registerBackground } from './registry'
export type {
  BackendKind,
  BackgroundContext,
  BackgroundDefinition,
  BackgroundHandle,
  BackgroundModule,
  BackgroundStarter,
} from './types'
