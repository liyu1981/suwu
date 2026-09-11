// Password credentials are kept in memory only. They are used exclusively
// to obtain the server's short-lived per-run Bearer token from /api/token.
let currentCredentials: string | null = null

/**
 * Stores Basic auth credentials in memory for the current page lifetime.
 * The value is base64("user:password") and is only sent to /api/token.
 */
export function setCredentials(user: string, password: string): void {
  currentCredentials = btoa(`${user}:${password}`)
}

/**
 * Returns the stored Authorization header value ("Basic <base64>"), or null.
 */
export function getCredentials(): string | null {
  return currentCredentials ? `Basic ${currentCredentials}` : null
}

/** Clears credentials after a failed authentication attempt or logout. */
export function clearCredentials(): void {
  currentCredentials = null
}
