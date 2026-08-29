import { getCredentials } from './auth'

/** Thrown when /api/token returns 401 (password required or wrong). */
export class AuthRequiredError extends Error {
  constructor() {
    super('auth required')
    this.name = 'AuthRequiredError'
  }
}

/**
 * Fetches the per-run same-origin auth token from the Go demo server.
 * The server mints a fresh random token on every start (e.g. each air dev
 * restart), so callers must fetch this before every WebSocket connection
 * attempt instead of caching it across restarts.
 *
 * If the server requires a password (returns 401), throws AuthRequiredError.
 * When stored credentials exist (from the login page), they are sent as a
 * Basic Authorization header.
 */
export async function fetchToken(): Promise<string> {
  const headers: Record<string, string> = {}
  const creds = getCredentials()
  if (creds) {
    headers['Authorization'] = creds
  }

  const res = await fetch('/api/token', { cache: 'no-store', headers })

  if (res.status === 401) {
    throw new AuthRequiredError()
  }
  if (!res.ok) {
    throw new Error(`token request failed with HTTP ${res.status}`)
  }

  const body = (await res.json()) as { token?: string }
  if (!body.token) {
    throw new Error('token response did not include a token')
  }
  return body.token
}
