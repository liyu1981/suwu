import { useAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { FONT_FAMILIES } from '../../store/appearance';
import {
  CODE_EDITOR_DEFAULTS,
  CODE_FONT_MIN,
  CODE_FONT_MAX,
  CODE_LINE_HEIGHT_MIN,
  CODE_LINE_HEIGHT_MAX,
  CODE_LINE_HEIGHT_STEP,
  codeEditorSettingsAtom,
} from '../../store/codeExplorer';
import { Combobox } from '../ui/combobox';

const section = 'rounded-[6px] border border-white/10 bg-black/20 p-3';
const hint = 'mt-2 text-[11px] leading-relaxed text-muted-foreground';
const items = FONT_FAMILIES.map((font) => ({ label: font.label, value: font.value }));

export function CodeExplorerSettings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useAtom(codeEditorSettingsAtom);

  return (
    <div className="space-y-4">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t('settings.codeExplorerHint')}
      </p>
      <div className={section}>
        <div className="text-xs font-medium text-muted-foreground">{t('settings.fontFamily')}</div>
        <div className="mt-2">
          <Combobox
            items={items}
            value={settings.fontFamily}
            onChange={(fontFamily) => setSettings({ ...settings, fontFamily })}
            placeholder={t('settings.fontFamily')}
            editable
          />
        </div>
        <p className={hint}>{t('settings.codeFontHint')}</p>
      </div>
      <div className={section}>
        <label
          htmlFor="code-editor-font-size"
          className="text-xs font-medium text-muted-foreground"
        >
          {t('settings.fontSize')}
        </label>
        <div className="mt-2 flex items-center gap-3">
          <input
            type="range"
            min={CODE_FONT_MIN}
            max={CODE_FONT_MAX}
            step={1}
            value={settings.fontSize}
            aria-label={t('settings.fontSize')}
            onChange={(event) => setSettings({ ...settings, fontSize: Number(event.target.value) })}
            className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded bg-white/15 accent-sky-400"
          />
          <input
            id="code-editor-font-size"
            type="number"
            min={CODE_FONT_MIN}
            max={CODE_FONT_MAX}
            step={1}
            value={settings.fontSize}
            onChange={(event) => {
              if (event.target.value !== '')
                setSettings({ ...settings, fontSize: event.target.valueAsNumber });
            }}
            className="w-20 rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-popover-foreground"
          />
          <span className="text-xs text-muted-foreground">px</span>
        </div>
      </div>
      <div className={section}>
        <label
          htmlFor="code-editor-line-height"
          className="text-xs font-medium text-muted-foreground"
        >
          {t('settings.lineHeight')}
        </label>
        <div className="mt-2 flex items-center gap-3">
          <input
            type="range"
            min={CODE_LINE_HEIGHT_MIN}
            max={CODE_LINE_HEIGHT_MAX}
            step={CODE_LINE_HEIGHT_STEP}
            value={settings.lineHeight}
            aria-label={t('settings.lineHeight')}
            onChange={(event) =>
              setSettings({ ...settings, lineHeight: Number(event.target.value) })
            }
            className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded bg-white/15 accent-sky-400"
          />
          <input
            id="code-editor-line-height"
            type="number"
            min={CODE_LINE_HEIGHT_MIN}
            max={CODE_LINE_HEIGHT_MAX}
            step={CODE_LINE_HEIGHT_STEP}
            value={settings.lineHeight}
            onChange={(event) => {
              if (event.target.value !== '')
                setSettings({ ...settings, lineHeight: event.target.valueAsNumber });
            }}
            className="w-20 rounded border border-white/10 bg-black/30 px-2 py-1 text-sm text-popover-foreground"
          />
          <span className="text-xs text-muted-foreground">×</span>
        </div>
        <p className={hint}>{t('settings.codeLineHeightHint')}</p>
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setSettings({ ...CODE_EDITOR_DEFAULTS })}
          className="glass-btn rounded bg-white/10 px-3 py-1.5 text-xs text-popover-foreground"
        >
          {t('settings.restoreDefault')}
        </button>
      </div>
    </div>
  );
}
