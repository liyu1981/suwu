import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

/** Last successful update check timestamp (epoch ms). */
export const lastUpdateCheckAtom = atomWithStorage<number>('suwu:last-update-check', 0)

/** Whether an upgrade is in progress. */
export const upgradingAtom = atom<boolean>(false)
