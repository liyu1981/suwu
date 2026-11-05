import { useEffect } from 'react';
import StaticServePanel from '../components/StaticServePanel';
import { setPageTransparent } from '../lib/constants';

/** Full-space static serve manager loaded inside each tiling pane's iframe. */
export default function StaticServePage() {
  useEffect(() => {
    setPageTransparent();
  }, []);
  return <StaticServePanel />;
}
