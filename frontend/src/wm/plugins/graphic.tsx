import i18n from '../../i18n'
import { registerTilePlugin, type TileRenderContext } from '../tilePlugins'

registerTilePlugin({
  id: 'graphic',
  get label() { return i18n.t('plugin.graphic') },
  get description() { return i18n.t('plugin.graphicDesc') },
  supportedParams: [
    { key: 'display', label: 'X display', description: 'X11 display to stream (e.g. :99). Xvfb is started automatically if missing.', defaultValue: ':99' },
    { key: 'title', label: 'Window title', description: 'Capture a specific window by WM_CLASS or name (default: largest window, auto-picked)' },
    { key: 'desktop', label: 'Full desktop', description: 'Set to 1 to capture the whole desktop instead of the app window' },
    { key: 'fps', label: 'FPS', description: 'Stream frame rate (max 60)', defaultValue: '30' },
  ],
  render: (paneId, context?: TileRenderContext) => {
    const p = new URLSearchParams({ pane: paneId })
    for (const [k, v] of Object.entries(context?.params ?? {})) {
      if (v) p.set(k, v)
    }
    return (
      <iframe
        src={`/graphic?${p}`}
        title={`graphic-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-black"
      />
    )
  },
})
