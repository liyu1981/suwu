/**
 * REST Helper Tile Plugin
 * Postman-like HTTP request investigator for the tiling window manager.
 */

import i18n from '../../i18n';
import { registerTilePlugin, type TileRenderContext } from '../tilePlugins';

registerTilePlugin({
  id: 'resthelper',
  get label() {
    return i18n.t('plugin.resthelper');
  },
  get description() {
    return i18n.t('plugin.resthelperDesc');
  },
  supportedParams: [
    { key: 'url', label: 'URL', description: 'Initial request URL' },
    { key: 'method', label: 'Method', description: 'HTTP method (default GET)' },
  ],
  render: (paneId, context?: TileRenderContext) => {
    const p = new URLSearchParams({ pane: paneId });
    if (context?.initialPath) {
      p.set('url', context.initialPath);
    }
    if (context?.params) {
      for (const [k, v] of Object.entries(context.params)) {
        p.set(k, v);
      }
    }
    return (
      <iframe
        src={`/resthelper?${p}`}
        title={`resthelper-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-transparent"
      />
    );
  },
});
