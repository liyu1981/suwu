import { atomWithStorage } from 'jotai/utils'

export interface AutoResolveSettings {
  filebrowser: boolean
  viewer: boolean
}

export const autoResolveAtom = atomWithStorage<AutoResolveSettings>('suwu:auto-resolve', {
  filebrowser: true,
  viewer: true,
})
