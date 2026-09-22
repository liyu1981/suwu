import { useState } from 'react';
import { TrashIcon } from '../icons';
import { cookieKey, type JarCookie } from '../../lib/cookie-jar';

interface Props {
  cookies: JarCookie[];
  targetHost: string;
  currentHost: string;
  onImportBrowser: () => void;
  onImportString: (raw: string) => void;
  onAdd: (cookie: JarCookie) => void;
  onRemove: (id: string) => void;
  onClearAll: () => void;
}

const inputClass =
  'rounded-lg border border-white/[0.10] bg-white/[0.03] px-2 py-1 text-xs text-white/80 outline-none focus:border-cyan-400/40';

function describeExpiry(cookie: JarCookie): string {
  if (cookie.expires === null) return 'session';
  if (cookie.expires <= Date.now()) return 'expired';
  return new Date(cookie.expires).toLocaleString();
}

export default function CookiesPanel({
  cookies,
  targetHost,
  currentHost,
  onImportBrowser,
  onImportString,
  onAdd,
  onRemove,
  onClearAll,
}: Props) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [domain, setDomain] = useState('');
  const [path, setPath] = useState('/');
  const [paste, setPaste] = useState('');

  const effectiveDomain = domain || targetHost || '';

  const add = () => {
    if (!name.trim() || !effectiveDomain) return;
    const cookie: JarCookie = {
      id: cookieKey({ domain: effectiveDomain, path: path || '/', name: name.trim() }),
      name: name.trim(),
      value,
      domain: effectiveDomain,
      path: path || '/',
      expires: null,
      secure: false,
      httpOnly: false,
      hostOnly: true,
      createdAt: Date.now(),
    };
    onAdd(cookie);
    setName('');
    setValue('');
  };

  const sameHost = targetHost !== '' && targetHost === currentHost;

  return (
    <div className="flex h-full flex-col gap-3 scrollbar-thin overflow-auto p-1">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onImportBrowser}
          disabled={!sameHost}
          title={
            sameHost
              ? 'Import readable cookies for this host'
              : 'Browser cookies are only readable on the Suwu host'
          }
          className="rounded-md bg-cyan-500/20 px-2.5 py-1 text-xs text-cyan-200 transition-colors hover:bg-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-30"
        >
          Import from browser
        </button>
        <button
          type="button"
          onClick={onClearAll}
          disabled={cookies.length === 0}
          className="flex items-center gap-1 rounded-md px-2.5 py-1 text-xs text-rose-300/80 transition-colors hover:bg-rose-500/15 hover:text-rose-300 disabled:opacity-30"
        >
          <TrashIcon className="h-3 w-3" />
          Clear all
        </button>
        {!sameHost && (
          <span className="text-[10px] text-amber-300/70">
            Browser cookies are only readable on the Suwu host — paste them below instead.
          </span>
        )}
      </div>

      <div className="space-y-1.5 rounded-lg border border-white/[0.08] bg-white/[0.02] p-2">
        <div className="flex flex-wrap gap-1.5">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            className={`${inputClass} w-32 font-mono`}
          />
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Value"
            className={`${inputClass} min-w-0 flex-1 font-mono`}
          />
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder={targetHost || 'domain'}
            className={`${inputClass} w-40 font-mono`}
          />
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/"
            className={`${inputClass} w-16 font-mono`}
          />
          <button
            type="button"
            onClick={add}
            disabled={!name.trim() || !effectiveDomain}
            className="rounded-md bg-white/[0.06] px-2.5 py-1 text-xs text-white/70 transition-colors hover:bg-white/[0.12] disabled:opacity-30"
          >
            Add
          </button>
        </div>
        <div className="flex gap-1.5">
          <input
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder="Paste cookie string: a=1; b=2"
            className={`${inputClass} min-w-0 flex-1 font-mono`}
          />
          <button
            type="button"
            onClick={() => {
              if (paste.trim() && targetHost) {
                onImportString(paste);
                setPaste('');
              }
            }}
            disabled={!paste.trim() || !targetHost}
            className="rounded-md bg-white/[0.06] px-2.5 py-1 text-xs text-white/70 transition-colors hover:bg-white/[0.12] disabled:opacity-30"
          >
            Import
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 scrollbar-thin overflow-auto rounded-lg border border-white/[0.08] bg-white/[0.02]">
        {cookies.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4 text-[11px] text-white/25">
            Cookie jar is empty
          </div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {cookies.map((cookie) => (
              <div key={cookie.id} className="flex items-center gap-2 px-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-mono text-xs">
                    <span className="text-cyan-300/90">{cookie.name}</span>
                    <span className="truncate text-white/50">= {cookie.value}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-white/30">
                    <span>
                      {cookie.domain}
                      {cookie.path}
                    </span>
                    <span>· {describeExpiry(cookie)}</span>
                    {cookie.secure && <span>· Secure</span>}
                    {cookie.httpOnly && <span>· HttpOnly</span>}
                    {cookie.sameSite && <span>· {cookie.sameSite}</span>}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onRemove(cookie.id)}
                  aria-label="Remove cookie"
                  title="Remove cookie"
                  className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-white/30 transition-colors hover:bg-rose-500/15 hover:text-rose-300"
                >
                  <TrashIcon className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
