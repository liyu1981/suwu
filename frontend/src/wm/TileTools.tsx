import { FONT_MAX, FONT_MIN, clampFont, fontSizeAtom } from '../store/fonts'
import { useAtomValue, useSetAtom } from 'jotai'
import type { MoveDir } from './layout'
import { ChevronIcon, CloseIcon, ResetFontSizeIcon } from './icons'

const MOVE_DIRS: MoveDir[] = ['left', 'right', 'up', 'down']
const ARROW_KEY: Record<MoveDir, string> = { left: '←', right: '→', up: '↑', down: '↓' }

const toolBtn =
  'grid h-5 w-5 place-items-center rounded text-slate-300 transition glass-btn hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-300'

const closeBtn =
  'grid h-5 w-5 place-items-center rounded text-slate-300 transition glass-btn hover:bg-rose-500/20 hover:text-rose-300'

const fontLabel = 'text-[9px] font-semibold leading-none'

interface TileToolsProps {
  paneId: string
  fontDefault: number
  canMove: (id: string, dir: MoveDir) => boolean
  move: (id: string, dir: MoveDir) => void
  closeTile: (id: string) => void
}

/**
 * Per-tile hover toolbar, revealed only while the cursor is near the
 * top-right corner — the invisible zone (w-56 × h-12) is the hover target,
 * so hovering elsewhere on the tile leaves the terminal untouched. The zone
 * is interactive (it must detect the approach), so clicks in that small
 * corner rect focus the tile without reaching the shell.
 *
 * Contents: shared font-size controls (global across panes) · per-tile
 * movement · per-tile close. Move buttons disable when no neighbor exists
 * that way; keyboard users have Alt+Arrows and Alt+Q.
 */
export function TileTools({ paneId, fontDefault, canMove, move, closeTile }: TileToolsProps) {
  const fontSize = useAtomValue(fontSizeAtom)
  const setFontSize = useSetAtom(fontSizeAtom)

  return (
    <div className="group/corner absolute right-0 top-0 z-10 h-12 w-56">
      <div
        className="pointer-events-none absolute right-1.5 top-1.5 flex gap-0.5 rounded-[6px] glass-control p-0.5 opacity-0 transition-opacity duration-150 group-hover/corner:pointer-events-auto group-hover/corner:opacity-100 motion-reduce:transition-none"
        role="toolbar"
        aria-label={`Tile tools ${paneId}`}
      >
        {/* Shared font size controls (global across panes) ... */}
        <button
          type="button"
          disabled={fontSize <= FONT_MIN}
          onClick={() => setFontSize(clampFont(fontSize - 1))}
          aria-label="Decrease font size"
          title="Decrease font size"
          className={toolBtn}
        >
          <span className={fontLabel}>A-</span>
        </button>
        <button
          type="button"
          disabled={fontSize >= FONT_MAX}
          onClick={() => setFontSize(clampFont(fontSize + 1))}
          aria-label="Increase font size"
          title="Increase font size"
          className={toolBtn}
        >
          <span className={fontLabel}>A+</span>
        </button>
        <button
          type="button"
          disabled={fontSize === fontDefault}
          onClick={() => setFontSize(fontDefault)}
          aria-label="Reset font size"
          title={`Reset font size (${fontDefault}px)`}
          className={toolBtn}
        >
          <ResetFontSizeIcon />
        </button>
        {/* ... then per-tile movement ... */}
        <div className="mx-0.5 my-0.5 w-px self-stretch bg-white/10" />
        {MOVE_DIRS.map((dir) => (
          <button
            key={dir}
            type="button"
            disabled={!canMove(paneId, dir)}
            onClick={() => move(paneId, dir)}
            aria-label={`Move tile ${dir}`}
            title={`Move tile ${dir} (Alt+${ARROW_KEY[dir]})`}
            className={toolBtn}
          >
            <ChevronIcon dir={dir} />
          </button>
        ))}
        {/* ... and per-tile close. */}
        <div className="mx-0.5 my-0.5 w-px self-stretch bg-white/10" />
        <button
          type="button"
          onClick={() => closeTile(paneId)}
          aria-label="Close tile"
          title="Close tile (Alt+Q closes the focused tile)"
          className={closeBtn}
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  )
}
