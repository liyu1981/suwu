import { atomWithStorage } from 'jotai/utils'
import { DEFAULT_BACKGROUND_ID } from '../components/background/constants'

export interface AutoResolveSettings {
  filebrowser: boolean
  fileviewer: boolean
  /** Open the port-forwarding tile when suwu forward starts — disabled by default. */
  forward: boolean
  /** Open the git graph tile when suwu gitgraph is used — enabled by default. */
  gitgraph: boolean
  /** Open the diff tile when suwu diff is used — enabled by default. */
  diff: boolean
}

export const autoResolveAtom = atomWithStorage<AutoResolveSettings>('suwu:auto-resolve', {
  filebrowser: true,
  fileviewer: true,
  forward: false,
  gitgraph: true,
  diff: true,
})

/**
 * The app-shell background the user chose in System Settings. Persisted in
 * localStorage; falls back to the default background when unset.
 */
export const backgroundAtom = atomWithStorage<string>('suwu:background', DEFAULT_BACKGROUND_ID)
