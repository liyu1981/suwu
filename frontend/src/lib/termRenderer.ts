/**
 * Which xterm renderer the terminal tiles should use.
 *
 * The WebGL renderer is an optimisation with a nasty failure mode: on some
 * devices it reports a working context, never fires `contextlost`, and still
 * composites nothing — the terminal then keeps its status bar and its
 * "Connected" badge and shows an empty screen (see
 * `docs/MOBILE_VIEW_PLAN.md` §14.1). Android Chrome and software rasterisers
 * have both produced it.
 *
 * So the choice is a preference the user can pin from the UI, with `auto` as the
 * default: `auto` skips WebGL when the GPU is a software rasteriser, `dom` always
 * uses xterm's built-in renderer (slowest, always correct), `webgl` forces the
 * accelerated one for people who know their device is fine with it.
 *
 * The value is a plain localStorage key (`suwu.term-renderer`) so the shell and
 * every tile iframe — separate documents — read the same answer.
 */
export type RendererPreference = 'auto' | 'dom' | 'webgl';

export const RENDERER_PREFERENCE_KEY = 'suwu.term-renderer';
export const RENDERER_PREFERENCES: readonly RendererPreference[] = ['auto', 'dom', 'webgl'];

export function parseRendererPreference(raw: string | null | undefined): RendererPreference {
  return raw === 'dom' || raw === 'webgl' ? raw : 'auto';
}

export function readRendererPreference(): RendererPreference {
  try {
    return parseRendererPreference(window.localStorage.getItem(RENDERER_PREFERENCE_KEY));
  } catch {
    return 'auto';
  }
}

export function writeRendererPreference(preference: RendererPreference): void {
  try {
    if (preference === 'auto') window.localStorage.removeItem(RENDERER_PREFERENCE_KEY);
    else window.localStorage.setItem(RENDERER_PREFERENCE_KEY, preference);
  } catch {
    // A private-mode quota error is not worth failing a renderer choice over.
  }
}

/**
 * Software rasterisers (SwiftShader, llvmpipe, swrast) advertise WebGL they
 * cannot composite. Probed once per document: a GL context is a scarce resource
 * and every tile would otherwise allocate one just to measure it.
 */
let softwareGl: boolean | null = null;

export function hasSoftwareGl(): boolean {
  if (softwareGl !== null) return softwareGl;
  softwareGl = true;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return softwareGl;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    // Release the probe context instead of holding one for the tab's lifetime.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    softwareGl = /swiftshader|llvmpipe|swrast|software|basic render/i.test(renderer);
  } catch {
    softwareGl = true;
  }
  return softwareGl;
}

/**
 * The renderer string the GPU reports, for the diagnostics line. '' when the
 * extension is unavailable (some browsers hide it for fingerprinting reasons).
 */
export function glRendererName(win: Window): string {
  try {
    const canvas = win.document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return 'no webgl';
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return '';
  }
}

/**
 * Whether this document looks like a phone or tablet: a coarse primary pointer.
 * A touch-screen laptop still reports `fine`, so this does not punish them.
 */
export function isTouchFirst(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/**
 * Whether a fresh document with this preference should load the WebGL addon.
 *
 * `auto` is deliberately conservative on phones: that is where a WebGL canvas
 * composites nothing (Android Chrome has done it, in several shops) and where a
 * terminal's throughput matters least. Anyone who prefers the accelerated
 * renderer can pin `webgl` from the tile's ⋯ panel.
 */
export function shouldUseWebgl(preference: RendererPreference): boolean {
  if (preference === 'dom') return false;
  if (preference === 'webgl') return true;
  return !isTouchFirst() && !hasSoftwareGl();
}
