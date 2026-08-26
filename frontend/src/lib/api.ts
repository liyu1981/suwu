import { useQuery } from '@tanstack/react-query'

/**
 * Fetches the per-run same-origin auth token from the Go demo server.
 * The token is stable for the lifetime of the server, so it is fetched once.
 */
export function useToken() {
  return useQuery({
    queryKey: ['token'],
    queryFn: async () => {
      const res = await fetch('/api/token', { cache: 'no-store' })
      if (!res.ok) {
        throw new Error(`token request failed with HTTP ${res.status}`)
      }
      const body = (await res.json()) as { token?: string }
      if (!body.token) {
        throw new Error('token response did not include a token')
      }
      return body.token
    },
  })
}