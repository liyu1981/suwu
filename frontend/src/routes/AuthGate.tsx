import { type FormEvent, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AmbientBackground } from '../components/AmbientBackground'
import AppShell from './AppShell'
import { AuthRequiredError, authenticate, fetchToken } from '../lib/api'

function LoginPage({ onAuthenticated }: { onAuthenticated: () => void }) {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(false)
    setLoading(true)
    try {
      await authenticate('suwu', password)
      setPassword('')
      onAuthenticated()
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="ambient-bg min-h-screen w-full overflow-x-clip text-slate-100">
      <AmbientBackground />
      <main className="relative z-10 flex min-h-screen items-center justify-center px-4">
        <form
          onSubmit={submit}
          className="glass-control menu-glass flex w-[min(92vw,22rem)] flex-col gap-4 rounded-2xl p-6 shadow-2xl"
        >
          <div className="flex flex-col items-center justify-center text-center">
            <img
              src="/logo.svg"
              alt="Suwu logo"
              width={192}
              height={192}
              className="h-48 w-48 rounded-[42px] shadow-[0_12px_40px_rgb(0_0_0/0.35)]"
            />
            <div className="mt-4">
              <div className="text-2xl font-semibold tracking-tight text-popover-foreground">{t('app.title')}</div>
            </div>
          </div>
          <div className="mt-3 flex flex-col gap-2">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="suwu-password">{t('auth.enterPassword')}</label>
            <input
              id="suwu-password"
              type="password"
              autoFocus
              required
              value={password}
              onChange={(event) => { setPassword(event.target.value); setError(false) }}
              placeholder={t('auth.passwordPlaceholder')}
              className="w-full rounded-[6px] border border-white/10 bg-white/5 px-3 py-2.5 text-xs text-white outline-none placeholder:text-white/30 transition focus:border-white/25 focus:bg-white/10 focus:ring-1 focus:ring-white/15"
            />
          </div>
          {error && <p className="text-center text-[11px] text-red-400">{t('auth.wrongPassword')}</p>}
          <button
            type="submit"
            disabled={loading || !password}
            className="glass-btn rounded-[6px] bg-white/10 px-3 py-2 text-xs font-medium text-white transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? t('auth.checking') : t('auth.connect')}
          </button>
        </form>
      </main>
    </div>
  )
}

export default function AuthGate() {
  const [status, setStatus] = useState<'checking' | 'login' | 'ready'>('checking')

  useEffect(() => {
    let cancelled = false
    const onExpired = () => setStatus('login')
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      if ((event.data as { type?: string } | undefined)?.type === 'auth-expired') onExpired()
    }
    window.addEventListener('suwu-auth-expired', onExpired)
    window.addEventListener('message', onMessage)
    fetchToken()
      .then(() => {
        if (!cancelled) setStatus('ready')
      })
      .catch((error) => {
        if (!cancelled && error instanceof AuthRequiredError) setStatus('login')
      })
    return () => {
      cancelled = true
      window.removeEventListener('suwu-auth-expired', onExpired)
      window.removeEventListener('message', onMessage)
    }
  }, [])

  if (status === 'ready') return <AppShell />
  if (status === 'login') return <LoginPage onAuthenticated={() => setStatus('ready')} />

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 text-xs text-white/50">
      Connecting...
    </div>
  )
}
