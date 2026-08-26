import { Link, Outlet } from '@tanstack/react-router'

const base = 'rounded-md px-3 py-1.5 text-sm font-medium transition'
const idle = 'text-slate-300 hover:bg-slate-700/40 hover:text-white'
const active = 'bg-slate-700/60 text-white'

export default function AppShell() {
  return (
    <div className="grid h-dvh grid-rows-[auto_1fr] bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-slate-100">
      <header className="border-b border-white/10 bg-slate-900/60 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-4 px-4 py-3">
          <span className="font-semibold tracking-tight">ghostty-web</span>
          <nav className="ml-auto flex items-center gap-1">
            <Link to="/" className={`${base} ${idle}`} activeProps={{ className: `${base} ${active}` }}>
              Tiling
            </Link>
            <Link to="/colors" className={`${base} ${idle}`} activeProps={{ className: `${base} ${active}` }}>
              Colors
            </Link>
          </nav>
        </div>
      </header>
      <main className="min-h-0 overflow-hidden p-3">
        <Outlet />
      </main>
    </div>
  )
}