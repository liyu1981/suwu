/**
 * Baikal Tile Plugin — a herdr-core client: spaces and agents on the left, one
 * attached terminal per tab on the right (docs/BAIKAL_PLAN.md).
 */

import i18n from '../../i18n';
import { registerTilePlugin, type TileRenderContext } from '../tilePlugins';

registerTilePlugin({
  id: 'baikal',
  get label() {
    return i18n.t('plugin.baikal');
  },
  get description() {
    return i18n.t('plugin.baikalDesc');
  },
  supportedParams: [
    {
      key: 'session',
      label: 'Core session',
      description: 'herdr-core session (default: "default")',
    },
  ],
  render: (paneId, context?: TileRenderContext) => {
    const p = new URLSearchParams({ pane: paneId });
    if (context?.params) {
      for (const [k, v] of Object.entries(context.params)) p.set(k, v);
    }
    return (
      <iframe
        src={`/baikal?${p}`}
        title={`baikal-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-transparent"
      />
    );
  },
});
