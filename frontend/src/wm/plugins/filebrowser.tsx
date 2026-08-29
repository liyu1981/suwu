import { registerTilePlugin } from '../tilePlugins'

registerTilePlugin({
  id: 'filebrowser',
  label: 'File Browser',
  description: 'Browse remote files and folders',
  render: (paneId) => (
    <iframe
      src={`/filebrowser?pane=${paneId}`}
      title={`filebrowser-${paneId}`}
      data-pane={paneId}
      className="h-full w-full border-0 bg-transparent"
    />
  ),
})
