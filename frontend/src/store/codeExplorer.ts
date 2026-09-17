import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'

export const CODE_FONT_MIN = 10
export const CODE_FONT_MAX = 32
export const CODE_LINE_HEIGHT_MIN = 1
export const CODE_LINE_HEIGHT_MAX = 2.5
export const CODE_LINE_HEIGHT_STEP = 0.1

export interface CodeEditorSettings {
  fontFamily: string
  fontSize: number
  /** Multiplier; converted to pixel line height for Monaco. */
  lineHeight: number
}

export const CODE_EDITOR_DEFAULTS: Readonly<CodeEditorSettings> = {
  fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
  fontSize: 14,
  lineHeight: 1.4,
}

/** Validate both UI writes and untrusted/stale localStorage values. */
export function normalizeCodeEditorSettings(value: unknown): CodeEditorSettings {
  const input = value && typeof value === 'object' ? value as Partial<CodeEditorSettings> : {}
  const family = typeof input.fontFamily === 'string' ? input.fontFamily.trim() : ''
  return {
    fontFamily: family && family.length <= 512 && !/[\x00-\x1f\x7f]/.test(family) ? family : CODE_EDITOR_DEFAULTS.fontFamily,
    fontSize: typeof input.fontSize === 'number' && Number.isFinite(input.fontSize)
      ? Math.min(CODE_FONT_MAX, Math.max(CODE_FONT_MIN, Math.round(input.fontSize)))
      : CODE_EDITOR_DEFAULTS.fontSize,
    lineHeight: typeof input.lineHeight === 'number' && Number.isFinite(input.lineHeight)
      ? Math.min(CODE_LINE_HEIGHT_MAX, Math.max(CODE_LINE_HEIGHT_MIN, Math.round(input.lineHeight * 10) / 10))
      : CODE_EDITOR_DEFAULTS.lineHeight,
  }
}

export function codeEditorFontOptions(value: unknown) {
  const settings = normalizeCodeEditorSettings(value)
  return {
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    lineHeight: Math.round(settings.fontSize * settings.lineHeight),
  }
}

// Storage events synchronize the parent settings dialog and every code iframe.
const storedCodeEditorSettingsAtom = atomWithStorage<unknown>('suwu.code-editor-settings', CODE_EDITOR_DEFAULTS)
export const codeEditorSettingsAtom = atom(
  (get) => normalizeCodeEditorSettings(get(storedCodeEditorSettingsAtom)),
  (_get, set, value: CodeEditorSettings) => set(storedCodeEditorSettingsAtom, normalizeCodeEditorSettings(value)),
)
