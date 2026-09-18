import { useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { DEFAULT_BACKGROUND_ID } from './constants';
import { getBackground } from './registry';
import { resolveBackgroundParams } from './params';
import { useBackground } from './useBackground';
import { backgroundParamsAtom } from '../../store/settings';
import type { BackendKind } from './types';

/** The chosen id, then the default — falling back if the chosen id is stale. */
function resolveBackgroundId(preferred?: string): string {
  const candidate = preferred ?? DEFAULT_BACKGROUND_ID;
  return getBackground(candidate) ? candidate : DEFAULT_BACKGROUND_ID;
}

export interface BackgroundCanvasProps {
  /** Registered background id. Defaults to the user's choice, then `ambient-blob`. */
  background?: string;
  /** Backend override; defaults to auto-detection (GPU, then CPU). */
  force?: BackendKind | 'auto';
}

/**
 * The app shell's full-viewport background canvas. Despite the old name it is
 * not specific to `ambient-blob` (that is merely the default background id): it
 * renders whichever background is selected, using the GPU backend when WebGPU
 * is available and falling back to the CPU backend otherwise (GPU-only
 * backgrounds render nothing without WebGPU). The active backend is exposed on
 * `data-backend` for debugging and perf tooling.
 *
 * The canvas is keyed by the background id: a canvas context type is permanent,
 * so switching backgrounds must start on a fresh element. The selected
 * background's parameters are resolved from System Settings and passed to the
 * backend; changing one restarts the backend (see `useBackground`).
 */
export function BackgroundCanvas({ background, force }: BackgroundCanvasProps) {
  const id = resolveBackgroundId(background);
  const paramOverrides = useAtomValue(backgroundParamsAtom);

  // `getBackground` returns a stable object per id, and `overrides` keeps its
  // identity unless this background's own params change — so unrelated writes
  // to the params atom never restart the running backend.
  const definition = useMemo(() => getBackground(id), [id]);
  const overrides = paramOverrides[id];
  const params = useMemo(
    () => (definition ? resolveBackgroundParams(definition, overrides) : undefined),
    [definition, overrides],
  );
  // Include the params in the canvas key: a params change starts a new backend,
  // and a fresh canvas guarantees the old surface is gone before the new one is
  // configured (a canvas context is a permanent, single-owner resource).
  const paramsKey = useMemo(() => (params ? JSON.stringify(params) : ''), [params]);

  const { canvasRef, canvasKey, backend } = useBackground({ id, force, params });
  return (
    <canvas
      key={`${id}-${paramsKey}-${canvasKey}`}
      ref={canvasRef}
      aria-hidden="true"
      data-backend={backend ?? undefined}
      className="pointer-events-none fixed inset-0 z-0 h-full w-full"
    />
  );
}
