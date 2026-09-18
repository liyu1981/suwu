import { useEffect } from 'react';
import DBBrowserPanel from '../components/dbbrowser/DBBrowserPanel';
import { setPageTransparent } from '../lib/constants';

/**
 * Full-space database browser page loaded inside each tiling pane's iframe.
 * Rendered outside the app shell so it has no header and fills the iframe.
 */
export default function DBBrowserPage() {
  useEffect(() => {
    setPageTransparent();
  }, []);
  return <DBBrowserPanel />;
}
