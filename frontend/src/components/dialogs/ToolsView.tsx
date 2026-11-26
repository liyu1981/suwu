import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckIcon, RefreshIcon, SearchIcon, TrashIcon } from '../icons';
import {
  type ToolSetupState,
  type ToolStatus,
  type ToolsResponse,
  fetchTools,
  installTool,
  setToolSetup,
  uninstallTool,
} from '../../lib/tools';

/**
 * Tools (a top-level screen, next to System Settings).
 *
 * The tools Suwu knows how to install, resolved by the server against this
 * machine: what the catalog offers, what is installed here, and the optional
 * shell integration fzf and asdf need. The tool directory's PATH block is not a
 * choice — Suwu keeps it in place — so this screen states that as a notice
 * instead of offering a toggle. Every action is a POST and the page re-reads
 * the server afterwards: the state lives on disk, never in this component
 * (docs/TOOLS_PLAN.md §9).
 */

// The shared settings vocabulary: Label at 12 px, Caption at 11 px, the same
// strings every other tab uses.
const section = 'rounded-[6px] border border-white/10 bg-black/20 p-3';
const sectionLabel = 'text-xs font-medium text-muted-foreground';
const sectionHint = 'mt-2 text-[11px] leading-relaxed text-muted-foreground';
const rowBorder = 'border-t border-white/5 first:border-t-0';

const smallBtn =
  'shrink-0 rounded border border-white/10 bg-black/30 px-2 py-1 text-xs outline-none ' +
  'transition-colors hover:bg-white/10 focus-visible:ring-1 focus-visible:ring-sky-400/60 ' +
  'disabled:cursor-not-allowed disabled:opacity-40';

const primaryBtn =
  'shrink-0 rounded border border-sky-500/40 bg-sky-500/15 px-2 py-1 text-xs text-sky-200 ' +
  'outline-none transition-colors hover:bg-sky-500/25 focus-visible:ring-1 focus-visible:ring-sky-400/60 ' +
  'disabled:cursor-not-allowed disabled:opacity-40';

const dangerBtn =
  'shrink-0 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-300 ' +
  'outline-none transition-colors hover:bg-red-500/20 focus-visible:ring-1 focus-visible:ring-red-400/60 ' +
  'disabled:cursor-not-allowed disabled:opacity-40';

const badge = 'rounded px-1.5 py-0.5 text-[11px] font-medium';

export function ToolsView() {
  const { t } = useTranslation();
  const [data, setData] = useState<ToolsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** The tool name currently being installed, removed or configured. */
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      setData(await fetchTools(refresh));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (name: string, action: () => Promise<string>) => {
      setBusy(name);
      setNotice(null);
      setError(null);
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

  const install = useCallback(
    (tool: ToolStatus) =>
      run(tool.name, async () => {
        // "Reinstall" on an installed row has to mean it: the version already
        // matches, so without force the server would correctly skip.
        const res = await installTool(tool.name, tool.state === 'installed');
        return res.skipped
          ? t('tools.alreadyInstalled', { name: tool.label, version: res.version })
          : t('tools.installed', { name: tool.label, version: res.version });
      }),
    [run, t],
  );

  const remove = useCallback(
    (tool: ToolStatus) =>
      run(tool.name, async () => {
        const res = await uninstallTool(tool.name);
        return t('tools.removed', { name: tool.label, files: (res.removed ?? []).join(', ') });
      }),
    [run, t],
  );

  const toggleSetup = useCallback(
    (tool: ToolStatus, setup: ToolSetupState) =>
      run(tool.name, async () => {
        const res = await setToolSetup(tool.name, !setup.enabled);
        return setup.enabled
          ? t('tools.setupRemoved', { files: (res.changed ?? []).join(', ') || '—' })
          : t('tools.setupAdded', { files: (res.files ?? []).join(', ') || '—' });
      }),
    [run, t],
  );

  // The catalog mixes catalog rows and the non-installable manual rows; one
  // query filters both by name, label, summary or version.
  const filtered = useMemo(() => {
    const tools = data?.tools ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter((tool) =>
      [tool.name, tool.label, tool.summary, tool.version].some((value) =>
        value?.toLowerCase().includes(q),
      ),
    );
  }, [data, query]);

  if (loading && !data) {
    return <p className={sectionHint}>{t('tools.loading')}</p>;
  }
  if (!data) {
    return (
      <div className={section}>
        <span className={sectionLabel}>{t('tools.title')}</span>
        <p className={sectionHint}>{error ?? t('tools.loadFailed')}</p>
        <button type="button" className={`${smallBtn} mt-3`} onClick={() => void load()}>
          {t('tools.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="min-w-0 flex-1 space-y-4">
      {/* ── Catalog ─────────────────────────────────────────────────────── */}
      <div className={section}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <span className={sectionLabel}>{t('tools.title')}</span>
            <p className={`${sectionHint} font-mono`}>{data.binDir}</p>
          </div>
          <button
            type="button"
            className={`${smallBtn} inline-flex items-center gap-1.5`}
            disabled={busy !== null}
            onClick={() => void load(true)}
          >
            <RefreshIcon />
            {t('tools.refresh')}
          </button>
        </div>
        {data.source.fallbackFrom && (
          <p className={sectionHint}>
            {t('tools.refFallback', { from: data.source.fallbackFrom, ref: data.source.ref })}
          </p>
        )}
        {data.source.stale && (
          <div className={`${sectionHint} text-amber-300/80`}>
            <p>{t('tools.stale', { ref: data.source.ref })}</p>
            {data.source.error && (
              <p className="mt-1 font-mono break-words text-[11px] text-amber-200/70">
                {data.source.error}
              </p>
            )}
          </div>
        )}

        <div className="relative mt-3">
          <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-muted-foreground/60">
            <SearchIcon className="h-3.5 w-3.5" />
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('tools.filterPlaceholder')}
            aria-label={t('tools.filterPlaceholder')}
            className="w-full rounded border border-white/10 bg-black/30 py-1.5 pr-2 pl-7 text-xs text-popover-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-sky-400/50 focus:ring-1 focus:ring-sky-400/20"
          />
        </div>

        <div className="mt-2">
          {filtered.map((tool) => (
            <ToolRow
              key={tool.name}
              tool={tool}
              setup={data.setup?.[tool.name]}
              busy={busy === tool.name}
              disabled={busy !== null && busy !== tool.name}
              onInstall={() => void install(tool)}
              onRemove={() => void remove(tool)}
              onToggleSetup={(setup) => void toggleSetup(tool, setup)}
            />
          ))}
          {filtered.length === 0 && query.trim() !== '' && (
            <p className={sectionHint}>{t('tools.noMatches', { query: query.trim() })}</p>
          )}
        </div>
      </div>

      {/* ── PATH notice ─────────────────────────────────────────────────── */}
      <div className={section}>
        <span className={sectionLabel}>{t('tools.pathTitle')}</span>
        <p className={sectionHint}>{t('tools.pathNotice')}</p>
        {(data.path.files ?? []).length > 0 && (
          <p className={`${sectionHint} font-mono`}>{data.path.files.join(', ')}</p>
        )}
      </div>

      {notice && (
        <p className="flex items-center gap-1.5 text-xs text-emerald-300/90">
          <CheckIcon /> {notice}
        </p>
      )}
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}

function ToolRow({
  tool,
  setup,
  busy,
  disabled,
  onInstall,
  onRemove,
  onToggleSetup,
}: {
  tool: ToolStatus;
  setup?: ToolSetupState;
  busy: boolean;
  disabled: boolean;
  onInstall: () => void;
  onRemove: () => void;
  onToggleSetup: (setup: ToolSetupState) => void;
}) {
  const { t } = useTranslation();
  const installedVersion = tool.installed?.version;
  const bundled = tool.installed?.origin === 'suwu-max';
  const inFlight = busy || disabled;

  return (
    <div className={`flex items-start gap-3 py-2.5 ${rowBorder}`}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-xs font-medium text-popover-foreground">{tool.label}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{tool.name}</span>
          {tool.version && (
            <span className="font-mono text-[11px] text-muted-foreground">{tool.version}</span>
          )}
          <StateBadge tool={tool} />
        </div>
        <p className={sectionHint}>{tool.summary}</p>
        {tool.manual && tool.instruction && (
          <div className="mt-2 rounded border border-white/5 bg-black/20 px-2 py-1.5">
            <p className={`${sectionHint} mt-0`}>{t('tools.manualHint')}</p>
            <pre className="mt-1 overflow-x-auto text-[11px] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
              {tool.instruction}
            </pre>
          </div>
        )}
        {tool.requires && tool.requires.length > 0 && (
          <p className={`${sectionHint} text-amber-300/70`}>
            {t('tools.requires', { list: tool.requires.join(', ') })}
          </p>
        )}
        {tool.state === 'unmanaged' && (
          <p className={`${sectionHint} text-amber-300/70`}>
            {t('tools.unmanagedHint', { path: tool.path })}
          </p>
        )}
        {bundled && tool.state !== 'installed' && (
          <p className={sectionHint}>{t('tools.bundledHint', { version: installedVersion })}</p>
        )}
        {setup && (tool.installed || setup.enabled) && (
          <div className="mt-2 rounded border border-white/5 bg-black/20 px-2 py-1.5">
            <p className={`${sectionHint} mt-0`}>
              {t('tools.setupHint', { command: setup.command })}
            </p>
            {setup.files.length > 0 && (
              <p className={`${sectionHint} mt-1 font-mono text-[10px]`}>
                {setup.files.join(', ')}
              </p>
            )}
            <button
              type="button"
              className={`mt-1.5 ${setup.enabled ? smallBtn : primaryBtn}`}
              disabled={inFlight}
              onClick={() => onToggleSetup(setup)}
            >
              {busy
                ? t('tools.working')
                : setup.enabled
                  ? t('tools.setupRemove')
                  : t('tools.setupAdd')}
            </button>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
        {tool.available && tool.state !== 'unmanaged' && (
          <button
            type="button"
            className={tool.state === 'installed' ? smallBtn : primaryBtn}
            disabled={inFlight}
            onClick={onInstall}
            title={tool.homepage}
          >
            {busy
              ? t('tools.working')
              : tool.state === 'installed'
                ? t('tools.reinstall')
                : tool.state === 'update'
                  ? t('tools.update')
                  : t('tools.install')}
          </button>
        )}
        {tool.installed && (
          <button
            type="button"
            className={`${dangerBtn} inline-flex items-center gap-1`}
            disabled={inFlight}
            onClick={onRemove}
            title={t('tools.removeHint')}
          >
            <TrashIcon />
          </button>
        )}
      </div>
    </div>
  );
}

function StateBadge({ tool }: { tool: ToolStatus }) {
  const { t } = useTranslation();
  const style: Record<ToolStatus['state'], string> = {
    installed: 'bg-emerald-500/15 text-emerald-300',
    update: 'bg-sky-500/15 text-sky-300',
    missing: 'bg-white/5 text-muted-foreground',
    unsupported: 'bg-white/5 text-muted-foreground',
    unmanaged: 'bg-amber-500/15 text-amber-300',
    manual: 'bg-white/5 text-muted-foreground',
  };
  // A manual row that is present is not Suwu-managed, so "installed" alone
  // would overclaim. Say what was actually observed.
  const key =
    tool.manual && tool.state === 'installed'
      ? 'tools.state.detected'
      : `tools.state.${tool.state}`;
  return <span className={`${badge} ${style[tool.state]}`}>{t(key)}</span>;
}
