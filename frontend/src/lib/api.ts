/**
 * Fetches the per-run same-origin auth token from the Go demo server.
 * The server mints a fresh random token on every start (e.g. each air dev
 * restart), so callers must fetch this before every WebSocket connection
 * attempt instead of caching it across restarts.
 */
export async function fetchToken(): Promise<string> {
  const res = await fetch('/api/token', { cache: 'no-store' })
  if (!res.ok) {
    throw new Error(`token request failed with HTTP ${res.status}`)
  }
  const body = (await res.json()) as { token?: string }
  if (!body.token) {
    throw new Error('token response did not include a token')
  }
  return body.token
}
