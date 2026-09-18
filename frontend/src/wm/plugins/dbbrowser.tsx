/**
 * DB Browser Tile Plugin
 * Database query & browser for the tiling window manager
 */

import i18n from '../../i18n';
import { registerTilePlugin, type TileRenderContext } from '../tilePlugins';

registerTilePlugin({
  id: 'dbbrowser',
  get label() {
    return i18n.t('plugin.dbbrowser');
  },
  get description() {
    return i18n.t('plugin.dbbrowserDesc');
  },
  supportedParams: [
    { key: 'driver', label: 'Database driver', description: 'sqlite, mysql, or postgres' },
    { key: 'host', label: 'Host', description: 'Database host' },
    { key: 'port', label: 'Port', description: 'Database port' },
    { key: 'database', label: 'Database', description: 'Database name or file path' },
  ],
  render: (paneId, context?: TileRenderContext) => {
    const p = new URLSearchParams({ pane: paneId });
    if (context?.initialPath) {
      p.set('path', context.initialPath);
    }
    if (context?.params) {
      for (const [k, v] of Object.entries(context.params)) {
        p.set(k, v);
      }
    }
    return (
      <iframe
        src={`/dbbrowser?${p}`}
        title={`dbbrowser-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-transparent"
      />
    );
  },
});
