import { atomWithStorage } from 'jotai/utils'

export interface AutoResolveSettings {
  filebrowser: boolean
  fileviewer: boolean
}

export const autoResolveAtom = atomWithStorage<AutoResolveSettings>('suwu:auto-resolve', {
  filebrowser: true,
  fileviewer: true,
})
