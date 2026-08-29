import { type FormEvent, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { clearCredentials, setCredentials } from '../../lib/auth'

/**
 * Password prompt dialog shown when the server requires authentication.
 * Overlays the tiling layout — the user sees the familiar interface behind
 * a translucent scrim and enters the password to unlock terminal access.
 */
export function AuthDialog({ open, onAuthenticated }: { open: boolean; onAuthenticated: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(false)
    setLoading(true)

    clearCredentials()
    setCredentials('suwu', password)

    try {
      const res = await fetch('/api/token', {
        cache: 'no-store',
        headers: { Authorization: `Basic ${btoa(`suwu:${password}`)}` },
      })
      if (res.ok) {
        setPassword('')
        onAuthenticated()
      } else {
        clearCredentials()
        setError(true)
      }
    } catch {
      clearCredentials()
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        aria-describedby={undefined}
        className="flex w-[min(92vw,18rem)] flex-col gap-0"
      >
        <DialogTitle className="text-center text-sm font-semibold tracking-tight text-popover-foreground">
          Enter password
        </DialogTitle>
        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3">
          <input
            type="password"
            autoFocus
            required
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(false) }}
            placeholder="Password"
            className="rounded-[6px] border border-white/10 bg-white/5 px-3 py-2 text-xs text-popover-foreground outline-none placeholder:text-white/30 focus:border-white/25 focus:ring-1 focus:ring-white/15"
          />
          {error && (
            <p className="text-center text-[11px] text-red-400">
              Wrong password, try again
            </p>
          )}
          <button
            type="submit"
            disabled={loading || !password}
            className="glass-btn rounded-[6px] bg-white/10 px-3 py-2 text-xs font-medium text-popover-foreground transition hover:bg-white/15 disabled:opacity-40"
          >
            {loading ? 'Checking…' : 'Connect'}
          </button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
