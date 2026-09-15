#!/usr/bin/env node
/**
 * Enforces the Suwu type scale.
 *
 * Source of truth: .opencode/skills/suwu-tile-plugin-design/SKILL.md
 *   Display 24  -> text-2xl
 *   Heading 16  -> text-base
 *   Body    14  -> text-sm
 *   Label   12  -> text-xs
 *   Caption 11  -> text-[11px]
 *   Micro   10  -> text-[10px]
 *   Glyph    9  -> text-[9px]   (toolbar letter marks only)
 *
 * Any other font-size utility (text-lg, text-[13px], ...) fails the check.
 * Color/alignment utilities such as `text-white` or `text-left` are ignored.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

const FRONTEND = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(FRONTEND, 'src')

const ALLOWED_NAMED = new Set(['xs', 'sm', 'base', '2xl'])
const ALLOWED_LENGTHS = new Set(['9px', '10px', '11px'])

const NAMED_RE = /\btext-(2xs|xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)\b/g
const ARBITRARY_RE = /\btext-\[([^\]]+)\]/g
const LENGTH_RE = /^[0-9.]+(px|rem|em)$/

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

const violations = []

for (const file of walk(SRC)) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    for (const m of line.matchAll(NAMED_RE)) {
      if (!ALLOWED_NAMED.has(m[1])) {
        violations.push({ file, line: i + 1, token: m[0] })
      }
    }
    for (const m of line.matchAll(ARBITRARY_RE)) {
      const value = m[1]
      if (LENGTH_RE.test(value) && !ALLOWED_LENGTHS.has(value)) {
        violations.push({ file, line: i + 1, token: m[0] })
      }
    }
  })
}

if (violations.length > 0) {
  console.error('Off-scale font sizes found (use the Suwu type scale):\n')
  for (const v of violations) {
    console.error(`  ${relative(FRONTEND, v.file)}:${v.line}  ${v.token}`)
  }
  console.error(
    '\nAllowed: text-2xl (24) · text-base (16) · text-sm (14) · text-xs (12) ·' +
      ' text-[11px] · text-[10px] · text-[9px]',
  )
  process.exit(1)
}

console.log('Typography check passed.')
