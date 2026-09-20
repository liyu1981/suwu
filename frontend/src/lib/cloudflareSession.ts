/**
 * Detects an expired Cloudflare Access (Zero Trust) session while the SPA is
 * already open, then sends the browser back through the edge to re-auth.
 *
 * Cloudflare Access lives at the edge: once the session lapses, Cloudflare
 * answers every request (including WebSocket upgrades) itself with a redirect
 * to the Access login page. An already-open tab cannot observe that, so the
 * notification socket just goes quiet. This watcher makes that failure visible
 * and recovers from it.
 *
 * Strategy:
 *   1. `/cdn-cgi/trace` is served by Cloudflare itself on every proxied
 *      domain, so it reveals whether this origin sits behind Cloudflare
 *      without relying on the app being reachable.
 *   2. When it does, probe `/cdn-cgi/access/get-identity`, which Cloudflare
 *      answers with the session identity. A redirect to the Access login page
 *      (or a 401/403) means the session is gone.
 *   3. If that probe is inconclusive (endpoint absent, network error), fall
 *      back to watching `document.cookie` for `CF_Authorization`.
 *   4. Recover by sending the browser to the site root, where Cloudflare
 *      Access intercepts the navigation and shows the login page.
 *
 * The cookie fallback only acts after it has seen `CF_Authorization` at least
 * once in the tab, because Cloudflare may mark that cookie `HttpOnly`. In that
 * case `document.cookie` never exposes it, and a bare "cookie is absent" check
 * would reload the page forever.
 */

const TRACE_URL = '/cdn-cgi/trace';
const IDENTITY_URL = '/cdn-cgi/access/get-identity';
const AUTH_COOKIE = 'CF_Authorization';
const START_DELAY_MS = 2_000;
const CHECK_INTERVAL_MS = 30_000;
/** Minimum gap between forced re-auth navigations, to bound any reload loop. */
const REAUTH_COOLDOWN_MS = 60_000;

/** sessionStorage key remembering that CF_Authorization was visible once. */
const SEEN_KEY = 'suwu:cf-authorization-seen';
/** sessionStorage key recording the last forced re-auth navigation. */
const REAUTH_AT_KEY = 'suwu:cf-reauth-at';

/** Result of probing Cloudflare's get-identity endpoint. */
type AccessSessionState = 'valid' | 'expired' | 'unknown';

let seenAuthorization = false;
try {
  seenAuthorization = sessionStorage.getItem(SEEN_KEY) === '1';
} catch {
  // sessionStorage can throw in privacy modes; fall back to in-memory only.
}

/** Last reported state, so logs fire on transitions instead of every cycle. */
let lastReportedState: string | null = null;

function report(state: string, message: string, level: 'info' | 'warn' = 'info'): void {
  if (lastReportedState === state) return;
  lastReportedState = state;
  if (level === 'warn') console.warn(message);
  else console.info(message);
}

function hasAuthorizationCookie(): boolean {
  return new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=`).test(document.cookie);
}

function rememberAuthorization(): void {
  if (seenAuthorization) return;
  seenAuthorization = true;
  try {
    sessionStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Ignore storage failures; the in-memory flag still covers this page.
  }
}

async function isBehindCloudflare(): Promise<boolean> {
  try {
    const res = await fetch(TRACE_URL, { cache: 'no-store' });
    if (!res.ok) return false;
    const text = await res.text();
    // Trace bodies are newline-separated key=value pairs.
    return /^fl=/m.test(text) && /^colo=/m.test(text);
  } catch {
    return false;
  }
}

/**
 * Asks Cloudflare whether the Access session is still valid.
 *
 * `redirect: 'manual'` surfaces the Access login redirect as an opaque
 * redirect response instead of following it cross-origin (which would be
 * CORS-blocked and indistinguishable from a network failure).
 */
async function probeAccessSession(): Promise<AccessSessionState> {
  try {
    const res = await fetch(IDENTITY_URL, {
      cache: 'no-store',
      redirect: 'manual',
      headers: { Accept: 'application/json' },
    });
    if (res.type === 'opaqueredirect') return 'expired';
    if (res.status === 401 || res.status === 403) return 'expired';
    if (res.ok) return 'valid';
    // 404 (no Access application) or anything unexpected — cookie fallback.
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function recentlyReauthenticated(): boolean {
  try {
    const at = Number(sessionStorage.getItem(REAUTH_AT_KEY) ?? '0');
    return Date.now() - at < REAUTH_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function reauthenticate(reason: string): void {
  if (recentlyReauthenticated()) {
    report(
      'cooldown',
      '[suwu] Cloudflare Access session looks expired, but a re-auth redirect just happened; not reloading again',
      'warn',
    );
    return;
  }
  try {
    // Reset the seen flag so the reloaded page starts clean and cannot loop if
    // Cloudflare still serves the app without a readable session cookie.
    sessionStorage.removeItem(SEEN_KEY);
    sessionStorage.setItem(REAUTH_AT_KEY, String(Date.now()));
  } catch {
    // Ignore storage failures.
  }
  console.warn(
    `[suwu] Cloudflare Access session expired (${reason}); redirecting to re-authenticate`,
  );
  window.location.replace('/');
}

async function checkSession(): Promise<void> {
  const state = await probeAccessSession();
  if (state === 'valid') {
    rememberAuthorization();
    report('get-identity-valid', '[suwu] Cloudflare Access session valid (get-identity)');
    return;
  }
  if (state === 'expired') {
    reauthenticate('get-identity reports expired');
    return;
  }

  // Inconclusive probe: fall back to the CF_Authorization cookie.
  report(
    'get-identity-unknown',
    '[suwu] Cloudflare get-identity inconclusive; falling back to CF_Authorization cookie',
  );
  if (hasAuthorizationCookie()) {
    rememberAuthorization();
    return;
  }
  if (!seenAuthorization) {
    // Never observed in this tab: either the cookie is HttpOnly or it has
    // not been written yet. Acting here would cause a reload loop.
    return;
  }
  reauthenticate('CF_Authorization cookie disappeared');
}

/**
 * Starts watching for Cloudflare Access session expiry. Called once at app
 * startup; the returned disposer stops the timers.
 */
export function startCloudflareSessionWatch(): () => void {
  console.info(
    `[suwu] Cloudflare Zero Trust detection scheduled (first check in ${START_DELAY_MS / 1000}s)`,
  );
  let interval: number | undefined;
  let checking = false;
  const startTimer = window.setTimeout(() => {
    void isBehindCloudflare().then((behind) => {
      if (!behind) {
        console.info(
          '[suwu] Cloudflare Zero Trust detection disabled: not served through Cloudflare',
        );
        return;
      }
      console.info(
        `[suwu] Cloudflare Zero Trust detection activated (checking every ${CHECK_INTERVAL_MS / 1000}s)`,
      );
      const run = () => {
        if (checking) return;
        checking = true;
        void checkSession().finally(() => {
          checking = false;
        });
      };
      run();
      interval = window.setInterval(run, CHECK_INTERVAL_MS);
    });
  }, START_DELAY_MS);

  return () => {
    window.clearTimeout(startTimer);
    if (interval !== undefined) window.clearInterval(interval);
  };
}
