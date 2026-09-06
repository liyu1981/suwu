import i18n from '../../i18n'
import { registerTilePlugin, type TileRenderContext } from '../tilePlugins'

registerTilePlugin({
  id: 'xdisplay',
  get label() { return i18n.t('plugin.xdisplay') },
  get description() { return i18n.t('plugin.xdisplayDesc') },
  supportedParams: [
    { key: 'display', label: 'Display number', description: 'X11 display number (default: 99). Xorg is started automatically.', defaultValue: '99' },
    { key: 'title', label: 'Window title', description: 'Capture a specific window by WM_CLASS or name (default: largest window, auto-picked)' },
    { key: 'desktop', label: 'Full desktop', description: 'Set to 1 to capture the whole desktop instead of the app window' },
    { key: 'fps', label: 'FPS', description: 'Stream frame rate (max 60)', defaultValue: '30' },
  ],
  render: (paneId, context?: TileRenderContext) => {
    const p = new URLSearchParams({ pane: paneId })
    // Always set display param with default of 99.
    p.set('display', context?.params?.display || '99')
    for (const [k, v] of Object.entries(context?.params ?? {})) {
      if (v && k !== 'display') p.set(k, v)
    }
    return (
      <iframe
        src={`/xdisplay?${p}`}
        title={`xdisplay-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-black"
      />
    )
  },
})
