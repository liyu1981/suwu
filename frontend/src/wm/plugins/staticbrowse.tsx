import i18n from '../../i18n';
import { registerTilePlugin, type TileRenderContext } from '../tilePlugins';

registerTilePlugin({
  id: 'staticbrowse',
  // Off by default: the CLI/Static Serve tile opens it on demand.
  defaultHidden: true,
  get label() {
    return i18n.t('plugin.staticBrowse');
  },
  get description() {
    return i18n.t('plugin.staticBrowseDesc');
  },
  supportedParams: [
    { key: 'id', label: 'Static serve id', description: 'Entry under /staticserve/<id>/' },
    { key: 'path', label: 'Path', description: 'Initial path inside the serve', defaultValue: '/' },
  ],
  render: (paneId, context?: TileRenderContext) => {
    const p = new URLSearchParams({ pane: paneId });
    const id = context?.params?.id;
    const path = context?.initialPath ?? context?.params?.path;
    if (id) p.set('id', id);
    if (path) p.set('path', path);
    return (
      <iframe
        src={`/static-browse?${p}`}
        title={`staticbrowse-${paneId}`}
        data-pane={paneId}
        className="h-full w-full border-0 bg-transparent"
      />
    );
  },
});
