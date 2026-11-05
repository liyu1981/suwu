import i18n from '../../i18n';
import { registerTilePlugin, type TileRenderContext } from '../tilePlugins';

registerTilePlugin({
  id: 'staticserve',
  get label() {
    return i18n.t('plugin.staticServe');
  },
  get description() {
    return i18n.t('plugin.staticServeDesc');
  },
  render: (paneId, _context?: TileRenderContext) => {
    const p = new URLSearchParams({ pane: paneId });
    return (
      <iframe
        src={`/static-serve?${p}`}
        title={`staticserve-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-transparent"
      />
    );
  },
});
