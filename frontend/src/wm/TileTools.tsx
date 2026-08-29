import { useTranslation } from 'react-i18next'
import type { MoveDir } from './layout'
import type { TilePlugin } from './tilePlugins'
import { ChevronIcon, CloseIcon } from './icons'

const MOVE_DIRS: MoveDir[] = ['left', 'right', 'up', 'down']
const ARROW_KEY: Record<MoveDir, string> = { left: '←', right: '→', up: '↑', down: '↓' }

const toolBtn =
  'grid h-5 w-5 place-items-center rounded text-slate-300 transition glass-btn hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-300'

const closeBtn =
  'grid h-5 w-5 place-items-center rounded text-slate-300 transition glass-btn hover:bg-rose-500/20 hover:text-rose-300'

interface TileToolsProps {
  paneId: string
  fontSize: number
  fontDefault: number
  setFontSize: (size: number) => void
  plugin?: TilePlugin
  canMove: (id: string, dir: MoveDir) => boolean
  move: (id: string, dir: MoveDir) => void
  closeTile: (id: string) => void
}

/**
 * Per-tile hover toolbar, revealed only while the cursor is near the
 * top-right corner. Composes:
 *   1. Type-specific plugin buttons (e.g. font size for term)
 *   2. Shared move buttons (left/right/up/down)
 *   3. Shared close button
 */
export function TileTools({
  paneId,
  fontSize,
  fontDefault,
  setFontSize,
  plugin,
  canMove,
  move,
  closeTile,
}: TileToolsProps) {
  const { t } = useTranslation()
  const pluginToolbar = plugin?.renderToolbar?.({
    paneId,
    fontSize,
    fontDefault,
    setFontSize,
    canMove,
    move,
    closeTile,
  })

  return (
    <div className="group/corner absolute right-0 top-0 z-10 h-12 w-56">
      <div
        className="pointer-events-none absolute right-1.5 top-1.5 flex gap-0.5 rounded-[6px] glass-control p-0.5 opacity-0 transition-opacity duration-150 group-hover/corner:pointer-events-auto group-hover/corner:opacity-100 motion-reduce:transition-none"
        role="toolbar"
        aria-label={`Tile tools ${paneId}`}
      >
        {pluginToolbar}
        {/* Shared per-tile movement */}
        <div className="mx-0.5 my-0.5 w-px self-stretch bg-white/10" />
        {MOVE_DIRS.map((dir) => (
          <button
            key={dir}
            type="button"
            disabled={!canMove(paneId, dir)}
            onClick={() => move(paneId, dir)}
            aria-label={t('wm.moveDir', { direction: dir })}
            title={`${t('wm.moveDir', { direction: dir })} (Alt+${ARROW_KEY[dir]})`}
            className={toolBtn}
          >
            <ChevronIcon dir={dir} />
          </button>
        ))}
        {/* Shared per-tile close */}
        <div className="mx-0.5 my-0.5 w-px self-stretch bg-white/10" />
        <button
          type="button"
          onClick={() => closeTile(paneId)}
          aria-label={t('wm.closeTile')}
          title={t('wm.closeTileHint')}
          className={closeBtn}
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  )
}
