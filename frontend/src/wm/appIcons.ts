/**
 * Shared icon color/letter logic for apps in both the picker and the
 * App Menu settings screen.
 */

const COLOR_MAP: Record<string, { bg: string; text: string; letter: string }> = {
  term: { bg: 'bg-sky-500/20', text: 'text-sky-400', letter: 'T' },
  fileviewer: { bg: 'bg-amber-500/20', text: 'text-amber-400', letter: 'V' },
  filebrowser: { bg: 'bg-orange-500/20', text: 'text-orange-400', letter: 'F' },
  forward: { bg: 'bg-cyan-500/20', text: 'text-cyan-400', letter: 'F' },
  gitgraph: { bg: 'bg-green-500/20', text: 'text-green-400', letter: 'G' },
  diff: { bg: 'bg-purple-500/20', text: 'text-purple-400', letter: 'D' },
  dropbox: { bg: 'bg-pink-500/20', text: 'text-pink-400', letter: 'D' },
  herdr: { bg: 'bg-emerald-500/20', text: 'text-emerald-400', letter: 'H' },
}

const DEFAULT_COLORS = { bg: 'bg-white/10', text: 'text-white/40', letter: '' }

export function getAppIconClasses(id: string): { bg: string; text: string } {
  const entry = COLOR_MAP[id]
  if (entry) return { bg: entry.bg, text: entry.text }
  return { bg: DEFAULT_COLORS.bg, text: DEFAULT_COLORS.text }
}

export function getAppIconLetter(id: string, label: string): string {
  const entry = COLOR_MAP[id]
  if (entry) return entry.letter
  return label.charAt(0).toUpperCase()
}
