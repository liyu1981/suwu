import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConnectParams, SftpAuthMode } from './api';
import type { SavedSftpConnection } from '../../store/sftp';

const inputCls =
  'w-full rounded-lg border border-white/[0.08] bg-white/[0.05] px-3 py-2 text-sm text-white outline-none transition-all duration-150 placeholder-white/25 focus:border-sky-400/40 focus:bg-white/[0.08] focus:ring-1 focus:ring-sky-400/20';

const segmentBtn =
  'flex-1 rounded-md px-2 py-1 text-xs transition-colors ' +
  'text-white/50 hover:bg-white/[0.06] hover:text-white/80 data-[active=true]:bg-white/10 data-[active=true]:text-white/90';

/**
 * Inline connection form shown inside a pane that is set to a remote endpoint
 * but not connected yet. Credentials are entered per connection and never
 * saved — only the host/user/port target is remembered.
 */
export function ConnectionForm({
  savedConnections,
  connecting,
  error,
  onConnect,
  onForget,
}: {
  savedConnections: SavedSftpConnection[];
  connecting: boolean;
  error: string | null;
  onConnect: (params: ConnectParams) => void;
  onForget: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [user, setUser] = useState('');
  const [auth, setAuth] = useState<SftpAuthMode>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');

  const submit = () => {
    const trimmedHost = host.trim();
    const trimmedUser = user.trim();
    if (!trimmedHost || !trimmedUser) return;
    const parsedPort = Number.parseInt(port, 10);
    onConnect({
      host: trimmedHost,
      port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : undefined,
      user: trimmedUser,
      auth,
      password: auth === 'password' ? password : undefined,
      privateKey: auth === 'key' ? privateKey : undefined,
      passphrase: auth === 'key' && passphrase ? passphrase : undefined,
    });
  };

  const loadSaved = (conn: SavedSftpConnection) => {
    setHost(conn.host);
    setPort(String(conn.port ?? 22));
    setUser(conn.user);
    setAuth(conn.auth);
  };

  return (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-3">
      <p className="text-[11px] leading-relaxed text-white/40">{t('sftp.connectHint')}</p>

      <div className="mt-3 space-y-3">
        <div className="flex gap-2">
          <div className="flex-[2]">
            <label className="mb-1 block text-xs font-medium text-white/45" htmlFor="sftp-host">
              {t('sftp.host')}
            </label>
            <input
              id="sftp-host"
              className={inputCls}
              value={host}
              placeholder="example.com"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setHost(e.target.value)}
            />
          </div>
          <div className="w-20">
            <label className="mb-1 block text-xs font-medium text-white/45" htmlFor="sftp-port">
              {t('sftp.port')}
            </label>
            <input
              id="sftp-port"
              className={inputCls}
              value={port}
              inputMode="numeric"
              onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-white/45" htmlFor="sftp-user">
            {t('sftp.user')}
          </label>
          <input
            id="sftp-user"
            className={inputCls}
            value={user}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setUser(e.target.value)}
          />
        </div>

        <div>
          <span className="mb-1 block text-xs font-medium text-white/45">{t('sftp.auth')}</span>
          <div className="flex gap-1 rounded-lg bg-white/[0.04] p-0.5">
            <button
              type="button"
              data-active={auth === 'password'}
              className={segmentBtn}
              onClick={() => setAuth('password')}
            >
              {t('sftp.authPassword')}
            </button>
            <button
              type="button"
              data-active={auth === 'key'}
              className={segmentBtn}
              onClick={() => setAuth('key')}
            >
              {t('sftp.authKey')}
            </button>
          </div>
        </div>

        {auth === 'password' ? (
          <div>
            <label className="mb-1 block text-xs font-medium text-white/45" htmlFor="sftp-password">
              {t('sftp.password')}
            </label>
            <input
              id="sftp-password"
              type="password"
              className={inputCls}
              value={password}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
            />
          </div>
        ) : (
          <>
            <div>
              <label className="mb-1 block text-xs font-medium text-white/45" htmlFor="sftp-key">
                {t('sftp.privateKey')}
              </label>
              <textarea
                id="sftp-key"
                className={`${inputCls} h-24 resize-none font-mono text-[11px]`}
                value={privateKey}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                spellCheck={false}
                onChange={(e) => setPrivateKey(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-white/45" htmlFor="sftp-pass">
                {t('sftp.passphrase')}
              </label>
              <input
                id="sftp-pass"
                type="password"
                className={inputCls}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </div>
          </>
        )}

        {error && <p className="text-[11px] text-red-300/80">{error}</p>}

        <button
          type="button"
          onClick={submit}
          disabled={connecting || !host.trim() || !user.trim()}
          className="w-full rounded-lg bg-sky-500/25 px-3 py-2 text-sm font-medium text-sky-200 transition-all duration-150 hover:bg-sky-500/35 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-30"
        >
          {connecting ? t('sftp.connecting') : t('sftp.connect')}
        </button>
      </div>

      {savedConnections.length > 0 && (
        <div className="mt-4 border-t border-white/[0.06] pt-3">
          <span className="text-xs font-medium text-white/45">{t('sftp.recent')}</span>
          <div className="mt-2 space-y-1">
            {savedConnections.map((conn) => (
              <div key={conn.id} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => loadSaved(conn)}
                  className="min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left text-xs text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white/85"
                  title={conn.label}
                >
                  {conn.label}
                </button>
                <button
                  type="button"
                  onClick={() => onForget(conn.id)}
                  className="rounded-md px-2 py-1 text-[11px] text-red-300/70 transition-colors hover:bg-red-500/15 hover:text-red-200"
                >
                  {t('sftp.forget')}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
