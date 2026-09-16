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

/** A named background with an optional CPU backend and an optional GPU backend. */
export interface BackgroundDefinition {
  readonly id: string
  readonly label: string
  readonly defaultParams?: Record<string, unknown>
  readonly cpu?: () => Promise<BackgroundModule>
  readonly gpu?: () => Promise<BackgroundModule>
}
