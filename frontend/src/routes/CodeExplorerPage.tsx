import { useEffect } from 'react';
import { CommonTileContainer } from '../components/CommonTileContainer';
import { CodeExplorer } from '../components/codeexplorer/CodeExplorer';
import { setPageTransparent } from '../lib/constants';
import { codeZoomAtom } from '../store/zoom';

/** Full-space Code Explorer page loaded inside each code tile's iframe. */
export default function CodeExplorerPage() {
  useEffect(() => {
    setPageTransparent();
  }, []);

  return (
    <CommonTileContainer zoomAtom={codeZoomAtom} noPadding>
      <CodeExplorer />
    </CommonTileContainer>
  );
}
