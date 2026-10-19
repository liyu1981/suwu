import i18n from '../../i18n';
import { registerTilePlugin, type TileRenderContext } from '../tilePlugins';

/**
 * SFTP Tile Plugin
 * Side-by-side file transfer between the Suwu host (or this browser) and a
 * remote machine over SFTP.
 */
registerTilePlugin({
  id: 'sftp',
  get label() {
    return i18n.t('plugin.sftp');
  },
  get description() {
    return i18n.t('plugin.sftpDesc');
  },
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
        src={`/sftp?${p}`}
        title={`sftp-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-transparent"
      />
    );
  },
});
