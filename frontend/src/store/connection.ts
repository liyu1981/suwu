import { atom } from 'jotai'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

export const connectionStatusAtom = atom<ConnectionStatus>('connecting')
export const connectionMessageAtom = atom('Authenticating...')