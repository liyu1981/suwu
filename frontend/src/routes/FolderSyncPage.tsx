import { useEffect } from 'react';
import { FolderSyncPanel } from '../components/foldersync/FolderSyncPanel';
import { setPageTransparent } from '../lib/constants';

/**
 * Full-space folder sync page loaded inside each tiling pane's iframe.
 * Rendered outside the app shell so it has no header and fills the frame.
 */
export default function FolderSyncPage() {
  useEffect(() => {
    setPageTransparent();
  }, []);
  return <FolderSyncPanel />;
}
