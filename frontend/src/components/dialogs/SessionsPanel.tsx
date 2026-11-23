import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshIcon } from '../icons';
import {
  type LoginSession,
  fetchSessions,
  relativeStamp,
  revokeOtherSessions,
  revokeSession,
} from '../../lib/sessions';

/**
 * The devices signed in to this server (System Settings → Account).
 *
 * Every device has its own login session, so revoking one leaves the others
 * working — this list is where that is visible, and where a lost phone is signed
 * out without changing the password. docs/AUTH_SESSIONS_PLAN.md §8.
 */

const section = 'rounded-[6px] border border-white/10 bg-black/20 p-3';
const sectionLabel = 'text-xs font-medium text-muted-foreground';
const sectionHint = 'mt-1 text-[11px] leading-relaxed text-muted-foreground';
const smallBtn =
  'shrink-0 rounded border border-white/10 bg-black/30 px-2 py-1 text-xs outline-none ' +
  'transition-colors hover:bg-white/10 focus-visible:ring-1 focus-visible:ring-sky-400/60 ' +
  'disabled:cursor-not-allowed disabled:opacity-40';
const dangerBtn =
  'shrink-0 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-300 ' +
  'outline-none transition-colors hover:bg-red-500/20 focus-visible:ring-1 focus-visible:ring-red-400/60 ' +
  'disabled:cursor-not-allowed disabled:opacity-40';

export function SessionsPanel() {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<LoginSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { sessions: list } = await fetchSessions();
      setSessions(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (key: string, action: () => Promise<string>) => {
      setBusy(key);
      setError(null);
      setNotice(null);
      try {
        const message = await action();
        await load();
        setNotice(message);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const revoke = useCallback(
    (session: LoginSession) =>
      run(`revoke-${session.id}`, async () => {
        await revokeSession(session.id);
        return t('sessions.revoked', { label: session.label });
      }),
    [run, t],
  );

  const revokeOthers = useCallback(
    () =>
      run('revoke-others', async () => {
        const count = await revokeOtherSessions(true);
        return count > 0 ? t('sessions.revokedOthers', { count }) : t('sessions.noOthers');
      }),
    [run, t],
  );

  const others = (sessions ?? []).filter((s) => !s.current);

  return (
    <div className={section}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className={sectionLabel}>{t('sessions.title')}</span>
          <p className={sectionHint}>{t('sessions.hint')}</p>
        </div>
        <button
          type="button"
          className={`${smallBtn} inline-flex items-center gap-1.5`}
          disabled={busy !== null}
          onClick={() => void load()}
        >
          <RefreshIcon />
          {t('sessions.refresh')}
        </button>
      </div>

      {sessions === null ? (
        <p className={sectionHint}>{t('sessions.loading')}</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {sessions.map((session) => (
            <li
              key={session.id}
              className="flex items-center gap-2 rounded border border-white/5 bg-black/20 px-2 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs text-popover-foreground">{session.label}</span>
                  {session.current && (
                    <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-300">
                      {t('sessions.thisDevice')}
                    </span>
                  )}
                  {session.legacy && !session.current && (
                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      {t('sessions.legacy')}
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-muted-foreground">
                  {t('sessions.lastSeen', { when: relativeStamp(session.lastSeen) })} ·{' '}
                  {t('sessions.expires', { when: relativeStamp(session.expires) })}
                </span>
              </div>
              <button
                type="button"
                className={dangerBtn}
                disabled={busy !== null}
                onClick={() => void revoke(session)}
              >
                {session.current ? t('sessions.signOut') : t('sessions.revoke')}
              </button>
            </li>
          ))}
        </ul>
      )}

      {others.length > 0 && (
        <button
          type="button"
          className={`${smallBtn} mt-3`}
          disabled={busy !== null}
          onClick={() => void revokeOthers()}
        >
          {t('sessions.revokeOthers', { count: others.length })}
        </button>
      )}
      {notice && <p className={`${sectionHint} text-emerald-300/90`}>{notice}</p>}
      {error && <p className={`${sectionHint} text-red-300`}>{error}</p>}
    </div>
  );
}
