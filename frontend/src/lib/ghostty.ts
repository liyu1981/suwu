import { Ghostty } from 'ghostty-web'
import wasmUrl from 'ghostty-web/ghostty-vt.wasm?url'

let ghosttyPromise: Promise<Ghostty> | null = null

/**
 * Loads the shared Ghostty WASM instance once and reuses it for every
 * Terminal. `ghostty-vt.wasm` is imported as a Vite asset so its URL is
 * correct in both the Vite dev server and the embedded production build.
 */
export function getGhostty(): Promise<Ghostty> {
  if (!ghosttyPromise) {
    ghosttyPromise = Ghostty.load(wasmUrl)
  }
  return ghosttyPromise
}