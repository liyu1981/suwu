import AuthGate from './AuthGate';
import { MobileShell } from '../mobile/MobileShell';

/**
 * `/mobile` — the phone shell.
 *
 * Same auth gate and the same tile iframes as the desktop view; only the chrome
 * differs (fixed header, one tile per screen, an overview to switch). Reached by
 * the redirect in `router.tsx`, and directly on a desktop for development.
 */
export default function MobilePage() {
  return (
    <AuthGate>
      <MobileShell />
    </AuthGate>
  );
}
