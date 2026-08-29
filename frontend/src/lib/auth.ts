const STORAGE_KEY = 'suwu-credentials'

/**
 * Stores Basic auth credentials in sessionStorage. The value is
 * base64("user:password") — sent as the Authorization header on /api/token.
 */
export function setCredentials(user: string, password: string): void {
  const encoded = btoa(`${user}:${password}`)
  sessionStorage.setItem(STORAGE_KEY, encoded)
}

/**
 * Returns the stored Authorization header value ("Basic <base64>"), or null
 * if no credentials have been saved.
 */
export function getCredentials(): string | null {
  const encoded = sessionStorage.getItem(STORAGE_KEY)
  return encoded ? `Basic ${encoded}` : null
}

/** Clears stored credentials (e.g. on logout or wrong password). */
export function clearCredentials(): void {
  sessionStorage.removeItem(STORAGE_KEY)
}
