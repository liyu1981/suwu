/** Which rendering backend a background is using. */
export type BackendKind = 'gpu' | 'cpu'

/** Runtime context handed to a background backend. */
export interface BackgroundContext {
  /** The canvas element to render into. */
  canvas: HTMLCanvasElement
  /** Allowed device-pixel-ratio range; backends clamp the live DPR into it. */
  dpr: readonly [number, number]
  /** Target frame rate for animated backgrounds. */
  fps: number
  /** Whether the user asked for reduced motion. */
  reducedMotion: boolean
  /**
   * Called when a backend cannot continue (e.g. a lost GPU device). The
   * wrapper remounts the canvas and retries with the CPU backend.
   */
  onFatal: (error: unknown) => void
}

/** A running background renderer. */
export interface BackgroundHandle {
  readonly backend: BackendKind
  dispose(): void
}

/**
 * Starts a backend. The params bag is opaque to the subsystem — each
 * background resolves its own typed params from it.
 */
export type BackgroundStarter = (
  ctx: BackgroundContext,
  params?: Record<string, unknown>,
) => Promise<BackgroundHandle>

/** A lazily-loaded backend module (the dynamic-import target). */
export interface BackgroundModule {
  readonly start: BackgroundStarter
}

/** A value a background parameter can take. */
export type BackgroundParamValue = number | boolean | string

interface BackgroundParamBase {
  /** Stable key in the params bag handed to the backend. */
  readonly key: string
  /** Control label shown in System Settings. */
  readonly label: string
  /** Optional helper line shown under the control. */
  readonly hint?: string
}

/** Continuous numeric parameter, rendered as a slider. */
export interface BackgroundNumberParam extends BackgroundParamBase {
  readonly kind: 'number'
  readonly default: number
  readonly min: number
  readonly max: number
  readonly step?: number
  /** Formats the value shown beside the slider. */
  readonly format?: (value: number) => string
}

/** On/off parameter, rendered as a switch. */
export interface BackgroundBooleanParam extends BackgroundParamBase {
  readonly kind: 'boolean'
  readonly default: boolean
}

/** One choice of a `select` parameter. */
export interface BackgroundSelectOption {
  readonly value: string
  readonly label: string
}

/** Enumerated parameter, rendered as a select. */
export interface BackgroundSelectParam extends BackgroundParamBase {
  readonly kind: 'select'
  readonly default: string
  readonly options: readonly BackgroundSelectOption[]
}

/** Free-form text parameter, rendered as a text input. */
export interface BackgroundTextParam extends BackgroundParamBase {
  readonly kind: 'text'
  readonly default: string
  /** Placeholder shown when empty. */
  readonly placeholder?: string
  /** Maximum stored length; longer input is truncated. Defaults to 2048. */
  readonly maxLength?: number
}

/**
 * A file persisted by a `fileList` parameter (e.g. a clip copied into OPFS).
 */
export interface BackgroundStoredFile {
  /** Stable id used as the stored param value. */
  readonly id: string
  /** Original file name, shown in the list. */
  readonly name: string
  readonly size: number
  readonly type: string
  readonly lastModified: number
  /** Thumbnail bytes (or null when one could not be generated). */
  readonly thumbnail: Blob | null
}

/**
 * A library of user-picked files. The selected file's id is what gets stored;
 * the bytes live wherever the background persists them (e.g. OPFS).
 */
export interface BackgroundFileListParam extends BackgroundParamBase {
  readonly kind: 'fileList'
  readonly default: string
  /** `accept` attribute for the file input. */
  readonly accept?: string
  /** Persist a picked file; resolve to the id to store. */
  readonly store: (file: File) => Promise<string>
  /** List persisted files (with thumbnails) for the picker. */
  readonly list: () => Promise<BackgroundStoredFile[]>
  /** Remove a persisted file by id. */
  readonly clear: (id: string) => Promise<void>
}

/** Colour parameter, rendered as a colour picker. Stored as `#rrggbb`. */
export interface BackgroundColorParam extends BackgroundParamBase {
  readonly kind: 'color'
  readonly default: string
}

/**
 * One user-adjustable background parameter. A background declares these in its
 * definition; System Settings renders the matching control and stores the
 * chosen value under the background id. Backends receive the resolved bag.
 */
export type BackgroundParam =
  | BackgroundNumberParam
  | BackgroundBooleanParam
  | BackgroundSelectParam
  | BackgroundTextParam
  | BackgroundFileListParam
  | BackgroundColorParam

/** A named background with an optional CPU backend and an optional GPU backend. */
export interface BackgroundDefinition {
  readonly id: string
  readonly label: string
  /**
   * User-adjustable parameters, rendered in System Settings and persisted per
   * background. Omit for a background with nothing to tune.
   */
  readonly params?: readonly BackgroundParam[]
  readonly cpu?: () => Promise<BackgroundModule>
  readonly gpu?: () => Promise<BackgroundModule>
}
