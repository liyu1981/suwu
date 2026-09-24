/**
 * Extension Tile Plugin
 *
 * A deliberately blank container tile: it wires the configured extension id and
 * any extra params into `/extension`, which then loads the gqjs-rendered page
 * from `/gqjs/<id>`. All behavior lives in the extension script — see
 * docs/EXTENSION_TILE_PLAN.md.
 */

import i18n from '../../i18n';
import { registerTilePlugin, type TileRenderContext } from '../tilePlugins';

registerTilePlugin({
  id: 'extension',
  get label() {
    return i18n.t('plugin.extension');
  },
  get description() {
    return i18n.t('plugin.extensionDesc');
  },
  supportedParams: [
    {
      key: 'id',
      label: 'Extension id',
      description: 'Registered extension to render (e.g. eye)',
    },
  ],
  render: (paneId, context?: TileRenderContext) => {
    const p = new URLSearchParams({ pane: paneId });
    if (context?.params) {
      for (const [k, v] of Object.entries(context.params)) p.set(k, v);
    }
    return (
      <iframe
        src={`/extension?${p}`}
        title={`extension-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-transparent"
      />
    );
  },
});
