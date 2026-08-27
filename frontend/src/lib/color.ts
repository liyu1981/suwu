/** Hex color helpers. Stored colors are #RRGGBBAA (alpha channel included). */

const HEX_DIGITS = /^#([0-9a-f]{3,8})$/

/** Extracts the (doubled, if needed) hex digit string of a color, or null. */
function hexDigits(value: string | undefined | null): string | null {
  const m = HEX_DIGITS.exec(value?.trim().toLowerCase() ?? '')
  if (!m) return null
  const d = m[1]
  if (d.length === 3 || d.length === 4) return [...d].map((c) => c + c).join('')
  if (d.length === 6 || d.length === 8) return d
  return null
}

/** Coerces any stored color to the #rrggbb form a color input expects. */
export function hex6Of(value: string | undefined | null, fallback: string): string {
  const d = hexDigits(value) ?? hexDigits(fallback)
  return d ? `#${d.slice(0, 6)}` : '#000000'
}

/** Alpha channel of a stored color as 0..1 (defaults to opaque). */
export function alphaOf(value: string | undefined | null): number {
  const d = hexDigits(value)
  return d && d.length === 8 ? parseInt(d.slice(6, 8), 16) / 255 : 1
}

/** Combines a #rrggbb color and a 0..1 alpha into a #rrggbbaa string. */
export function withAlpha(hex6: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
  const digits = hexDigits(hex6)?.slice(0, 6) ?? '000000'
  return `#${digits}${a.toString(16).padStart(2, '0')}`
}
