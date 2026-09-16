export const GLYPH_WIDTH = 24
export const GLYPH_HEIGHT = 30
/** u32 words per glyph = ceil(GLYPH_WIDTH * GLYPH_HEIGHT / 32). */
export const WORDS_PER_GLYPH = Math.ceil((GLYPH_WIDTH * GLYPH_HEIGHT) / 32)

export interface GlyphAtlas {
  /** Bit-packed coverage, one bit per pixel, LSB-first within each u32. */
  readonly words: Uint32Array<ArrayBuffer>
  readonly glyphCount: number
}

// Prefer a font that has half-width katakana; fall back to common monospace.
const FONT_STACK =
  "'Noto Sans SC Variable', 'Noto Sans Mono CJK JP', 'Noto Sans Mono CJK SC', " +
  "'Hiragino Kaku Gothic ProN', 'MS Gothic', 'DejaVu Sans Mono', Menlo, Consolas, monospace"

function buildCharset(): string[] {
  const chars: string[] = []
  // ASCII printable: latin letters, digits, punctuation.
  for (let code = 0x21; code <= 0x7e; code++) chars.push(String.fromCodePoint(code))
  // Half-width katakana — the classic Matrix glyph set.
  for (let code = 0xff61; code <= 0xff9f; code++) chars.push(String.fromCodePoint(code))
  return chars
}

export const GLYPH_CHARSET = buildCharset()

/** Pack 0/1 coverage bitmaps (row-major, GLYPH_WIDTH x GLYPH_HEIGHT) into u32 words. */
export function packGlyphBitmaps(bitmaps: readonly Uint8Array[]): Uint32Array<ArrayBuffer> {
  const words = new Uint32Array(bitmaps.length * WORDS_PER_GLYPH)
  bitmaps.forEach((bitmap, glyph) => {
    const base = glyph * WORDS_PER_GLYPH
    for (let i = 0; i < bitmap.length; i++) {
      if (bitmap[i]) words[base + (i >> 5)] |= 1 << (i & 31)
    }
  })
  return words
}

/**
 * Rasterise the charset once with a 2D canvas and pack it into a 1-bit atlas.
 * Blank glyphs (a font lacking them) are dropped, so `glyphCount` may be
 * smaller than the charset — that keeps the effect working even when only
 * ASCII is available.
 */
export async function buildGlyphAtlas(): Promise<GlyphAtlas> {
  if (typeof document === 'undefined') {
    throw new Error('matrix-rain: glyph atlas requires a DOM canvas')
  }
  await loadFonts()

  const canvas = document.createElement('canvas')
  canvas.width = GLYPH_WIDTH
  canvas.height = GLYPH_HEIGHT
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('matrix-rain: 2D context unavailable')

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `${Math.round(GLYPH_HEIGHT * 0.95)}px ${FONT_STACK}`
  ctx.fillStyle = '#ffffff'

  const bitmaps: Uint8Array[] = []
  for (const char of GLYPH_CHARSET) {
    ctx.clearRect(0, 0, GLYPH_WIDTH, GLYPH_HEIGHT)
    ctx.fillText(char, GLYPH_WIDTH / 2, GLYPH_HEIGHT / 2)
    const { data } = ctx.getImageData(0, 0, GLYPH_WIDTH, GLYPH_HEIGHT)
    const coverage = new Uint8Array(GLYPH_WIDTH * GLYPH_HEIGHT)
    let ink = 0
    for (let i = 0; i < coverage.length; i++) {
      if (data[i * 4 + 3] > 96) {
        coverage[i] = 1
        ink++
      }
    }
    if (ink > 0) bitmaps.push(coverage)
  }

  return { words: packGlyphBitmaps(bitmaps), glyphCount: bitmaps.length }
}

async function loadFonts(): Promise<void> {
  const fonts = document.fonts
  if (!fonts) return
  try {
    // Force the subsets we need (kana + latin) to load before rasterising.
    await fonts.load(`16px ${FONT_STACK}`, GLYPH_CHARSET.join(''))
  } catch {
    // Best-effort; missing glyphs are dropped in buildGlyphAtlas.
  }
  await fonts.ready
}
