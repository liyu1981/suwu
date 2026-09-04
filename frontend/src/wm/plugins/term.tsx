import { FONT_MAX, FONT_MIN, clampFont } from '../../store/fonts'
import { ResetFontSizeIcon } from '../icons'
import { registerTilePlugin, type ToolbarContext, type TileRenderContext } from '../tilePlugins'
import i18n from '../../i18n'

const toolBtn =
  'grid h-5 w-5 place-items-center rounded text-slate-300 transition glass-btn hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-300'

const fontLabel = 'text-[9px] font-semibold leading-none'

function TermToolbar({ fontSize, fontDefault, setFontSize }: ToolbarContext) {
  return (
    <>
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
    </>
  )
}

registerTilePlugin({
  id: 'term',
  get label() { return i18n.t('plugin.terminal') },
  get description() { return i18n.t('plugin.terminalDesc') },
  supportedParams: [
    { key: 'cmd', label: 'Command', description: 'Shell command to execute' },
    { key: 'cwd', label: 'Working directory', description: 'Initial directory path' },
  ],
  render: (paneId, context?: TileRenderContext) => {
    const p = new URLSearchParams({ pane: paneId })
    if (context?.params) {
      for (const [k, v] of Object.entries(context.params)) {
        p.set(k, v)
      }
    }
    return (
      <iframe
        src={`/term?${p}`}
        title={`terminal-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-transparent"
      />
    )
  },
  renderToolbar: (ctx) => <TermToolbar {...ctx} />,
})
