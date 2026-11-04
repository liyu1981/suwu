import { useTranslation } from 'react-i18next';

/**
 * Shared bits of the two snippet editing surfaces — the save-current-input
 * confirm dialog and the manager's inline row editor. They differ in layout
 * (dialog vs table row) but must not drift in wording or affordances.
 */

export const SNIPPET_INPUT =
  'w-full rounded border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-sm text-white/85 outline-none transition placeholder:text-white/30 focus:border-sky-400/60 focus:ring-1 focus:ring-sky-400/30';

export const SNIPPET_GHOST_BTN =
  'rounded px-2 py-1 text-xs font-medium text-white/60 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-40';

export const SNIPPET_PRIMARY_BTN =
  'rounded bg-sky-600 px-2 py-1 text-xs font-medium text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40';

export const SNIPPET_DANGER_BTN =
  'rounded px-2 py-1 text-xs font-medium text-white/50 transition hover:bg-red-500/15 hover:text-red-300';

/** The one option a snippet has beyond its text. */
export function AutoReturnToggle({
  id,
  checked,
  onChange,
}: {
  id: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1.5">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3 w-3 accent-sky-500"
      />
      <label htmlFor={id} className="text-xs text-white/60">
        {t('terminal.snippets.autoReturn')}
      </label>
    </div>
  );
}
