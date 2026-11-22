import { clearCredentials, getCredentials, setCredentials } from './auth';

/** Thrown when /api/token returns 401 (password required or wrong). */
export class AuthRequiredError extends Error {
  constructor() {
    super('auth required');
    this.name = 'AuthRequiredError';
  }
}

const TOKEN_COOKIE = 'suwu_token';

let authGeneration = 0;
let tokenRequest: {
  generation: number;
  promise: Promise<string>;
} | null = null;

function getTokenCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const encoded = document.cookie.split('; ').find((entry) => entry.startsWith(`${TOKEN_COOKIE}=`));
  return encoded ? decodeURIComponent(encoded.slice(TOKEN_COOKIE.length + 1)) : null;
}

function setTokenCookie(token: string): void {
  if (typeof document === 'undefined') return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; SameSite=Lax${secure}`;
}

function clearTokenCookie(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${TOKEN_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`;
}

function notifyAuthExpired(): void {
  clearTokenCookie();
  clearCredentials();
  authGeneration++;
  tokenRequest = null;

  if (window.parent !== window) {
    window.parent.postMessage({ type: 'auth-expired' }, window.location.origin);
  } else {
    window.dispatchEvent(new Event('suwu-auth-expired'));
  }
}

async function requestToken(): Promise<string> {
  const headers: Record<string, string> = {};
  const credentials = getCredentials();
  if (credentials) headers.Authorization = credentials;

  console.debug('[suwu auth] requesting token', {
    hasBasicAuthorization: Boolean(credentials),
  });
  const res = await fetch('/api/token', { cache: 'no-store', headers });
  if (res.status === 401) throw new AuthRequiredError();
  if (!res.ok) throw new Error(`token request failed with HTTP ${res.status}`);

  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error('token response did not include a token');
  setTokenCookie(body.token);
  return body.token;
}

function startTokenRequest(generation: number): Promise<string> {
  const existing = tokenRequest;
  if (existing?.generation === generation) return existing.promise;

  const entry = { generation, promise: requestToken() };
  tokenRequest = entry;
  void entry.promise.then(
    () => {
      if (tokenRequest === entry) tokenRequest = null;
    },
    () => {
      if (tokenRequest === entry) tokenRequest = null;
    },
  );
  return entry.promise;
}

/** Fetches the token, sharing an in-flight request within the auth generation. */
export async function fetchToken(): Promise<{
  token: string;
  signedFetch: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
}> {
  const cookieToken = getTokenCookie();
  if (cookieToken) return { token: cookieToken, signedFetch: authFetch };

  const generation = authGeneration;
  const token = await startTokenRequest(generation);
  if (generation !== authGeneration) return fetchToken();
  return { token, signedFetch: authFetch };
}

/** Authenticates with a password and starts a fresh token request. */
export async function authenticate(user: string, password: string): Promise<void> {
  authGeneration++;
  clearTokenCookie();
  tokenRequest = null;
  setCredentials(user, password);

  try {
    await fetchToken();
  } catch (error) {
    clearTokenCookie();
    clearCredentials();
    authGeneration++;
    tokenRequest = null;
    throw error;
  }
}

/**
 * Sends an authenticated API request with the cookie-backed Bearer token.
 * A 401 clears authentication and returns the UI to the login surface.
 */
export async function authFetch(input: URL | RequestInfo, init?: RequestInit): Promise<Response> {
  const token = getTokenCookie() ?? (await fetchToken()).token;
  const req = new Request(input, init);
  const headers = new Headers(req.headers);
  headers.set('Authorization', `Bearer ${token}`);
  console.debug('[suwu auth] adding Bearer authorization', {
    url: req.url,
    hasBearerAuthorization: headers.get('Authorization')?.startsWith('Bearer ') === true,
  });

  const response = await fetch(new Request(req, { headers }));
  if (response.status === 401) notifyAuthExpired();
  return response;
}

/**
 * Reads a response that is expected to be JSON, turning a non-2xx into the
 * server's own message. Reads the body as text first: an error from a proxy is a
 * plain-text page, and "HTTP 502" tells the user less than what the proxy said.
 */
async function readJson<T>(response: Response, what: string): Promise<T> {
  const text = await response.text().catch(() => '');
  let payload: (T & { error?: string }) | null = null;
  try {
    payload = text ? (JSON.parse(text) as T & { error?: string }) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(payload?.error || text.trim() || `${what} failed (${response.status})`);
  }
  return (payload ?? ({} as T)) as T;
}

/** GET a JSON endpoint with the cookie-backed token. */
export async function fetchJson<T>(url: string): Promise<T> {
  return readJson<T>(await authFetch(url, { cache: 'no-store' }), url);
}

/** POST a JSON body, and read the JSON answer. */
export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await authFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(body),
  });
  return readJson<T>(response, path);
}

/**
 * Logs the user out: drops the Bearer token cookie and the in-memory
 * credentials, then reloads so the app returns to the login surface.
 */
export function logout(): void {
  notifyAuthExpired();
  window.location.reload();
}
