import { useEffect } from 'react';
import SftpPanel from '../components/sftp/SftpPanel';
import { setPageTransparent } from '../lib/constants';

/**
 * Full-space SFTP page loaded inside each tiling pane's iframe. Rendered
 * outside the app shell so it has no header and fills the iframe.
 */
export default function SftpPage() {
  useEffect(() => {
    setPageTransparent();
  }, []);
  return <SftpPanel />;
}
