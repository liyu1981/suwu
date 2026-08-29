import { registerTilePlugin } from '../tilePlugins'

registerTilePlugin({
  id: 'viewer',
  label: 'Viewer',
  render: (paneId) => (
    <iframe
      src={`/viewer?pane=${paneId}`}
      title={`viewer-${paneId}`}
      data-pane={paneId}
      className="h-full w-full border-0 bg-transparent"
    />
  ),
})
