import { atomWithStorage } from 'jotai/utils'

export interface AutoResolveSettings {
  filebrowser: boolean
  fileviewer: boolean
  /** Open the port-forwarding tile when suwu forward starts — disabled by default. */
  forward: boolean
}

export const autoResolveAtom = atomWithStorage<AutoResolveSettings>('suwu:auto-resolve', {
  filebrowser: true,
  fileviewer: true,
  forward: false,
})
