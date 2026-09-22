import { useEffect } from 'react';
import { RestHelperPanel } from '../components/resthelper/RestHelperPanel';
import { setPageTransparent } from '../lib/constants';

/**
 * Full-space REST Helper page loaded inside each tiling pane's iframe.
 * Rendered outside the app shell so it has no header and fills the frame.
 */
export default function RestHelperPage() {
  useEffect(() => {
    setPageTransparent();
  }, []);
  const paneId = new URLSearchParams(window.location.search).get('pane') ?? undefined;
  return <RestHelperPanel paneId={paneId} />;
}
