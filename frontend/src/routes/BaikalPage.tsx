import { useEffect } from 'react';
import { BaikalPanel } from '../components/baikal/BaikalPanel';
import { setPageTransparent } from '../lib/constants';

/**
 * Full-space Baikal page loaded inside each tiling pane's iframe: the
 * herdr-core client tile (spaces on the left, attached terminals on the right).
 */
export default function BaikalPage() {
  useEffect(() => {
    setPageTransparent();
  }, []);
  return <BaikalPanel />;
}
