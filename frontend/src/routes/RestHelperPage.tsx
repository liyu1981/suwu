import { useEffect } from 'react';
import { RestHelperPanel } from '../components/resthelper/RestHelperPanel';
import { setPageTransparent } from '../lib/constants';
import { paneIdFromLocation } from '../lib/pane';

/**
 * Full-space REST Helper page loaded inside each tiling pane's iframe.
 * Rendered outside the app shell so it has no header and fills the frame.
 */
export default function RestHelperPage() {
  useEffect(() => {
    setPageTransparent();
  }, []);
  const paneId = paneIdFromLocation() || undefined;
  return <RestHelperPanel paneId={paneId} />;
}
