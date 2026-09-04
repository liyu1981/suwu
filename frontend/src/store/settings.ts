import { atomWithStorage } from 'jotai/utils'

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
