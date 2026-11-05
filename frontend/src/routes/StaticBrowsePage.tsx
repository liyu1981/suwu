import { useEffect } from 'react';
import StaticBrowsePanel from '../components/StaticBrowsePanel';
import { setPageTransparent } from '../lib/constants';

/** Full-space static preview browser loaded inside each tiling pane's iframe. */
export default function StaticBrowsePage() {
  useEffect(() => {
    setPageTransparent();
  }, []);
  return <StaticBrowsePanel />;
}
