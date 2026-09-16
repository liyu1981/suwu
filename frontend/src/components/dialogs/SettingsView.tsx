import { useEffect, useState } from 'react'
import { useAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import i18n from 'i18next'
import { Tabs as TabsPrimitive } from 'radix-ui'
import { maxEntriesAtom } from '../../store/notifications'
import { autoResolveAtom, backgroundAtom, backgroundParamsAtom } from '../../store/settings'
import { Select, SelectTrigger, SelectContent, SelectItem } from '../ui/select'
import { Combobox } from '../ui/combobox'
import { getBackground, listBackgrounds, resolveBackgroundParams } from '../background'
import type {
  BackgroundBooleanParam,
  BackgroundNumberParam,
  BackgroundParam,
  BackgroundParamValue,
  BackgroundSelectParam,
} from '../background'

const section = 'rounded-[6px] border border-white/10 bg-black/20 p-3'
const sectionLabel = 'text-xs font-medium text-muted-foreground'
const sectionHint = 'mt-2 text-[11px] leading-relaxed text-muted-foreground'

const tabBtn =
  'rounded px-2.5 py-1.5 text-left text-xs text-muted-foreground outline-none transition-colors ' +
  'hover:bg-white/5 hover:text-popover-foreground focus-visible:ring-1 focus-visible:ring-sky-400/60 ' +
  'data-[state=active]:bg-white/10 data-[state=active]:text-popover-foreground'

const toggle =
  'relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors ' +
  'bg-white/15 data-[state=checked]:bg-sky-500/60'

const toggleThumb =
  'block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition-transform ' +
  'data-[state=checked]:translate-x-4'

function Toggle({
  checked,
  onCheckedChange,
}: {
  checked: boolean
  onCheckedChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-state={checked ? 'checked' : 'unchecked'}
      className={toggle}
      onClick={() => onCheckedChange(!checked)}
    >
      <span data-state={checked ? 'checked' : 'unchecked'} className={toggleThumb} />
    </button>
  )
}

function NumberField({
  param,
  value,
  onChange,
}: {
  param: BackgroundNumberParam
  value: number
  onChange: (value: number) => void
}) {
  const [local, setLocal] = useState(value)
  useEffect(() => setLocal(value), [value])

  // Commit on release, not while dragging: a params change restarts the
  // backend, so a continuous write would thrash the renderer mid-drag.
  const commit = (input: HTMLInputElement) => {
    const next = Number(input.value)
    if (next !== value) onChange(next)
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className={sectionLabel}>{param.label}</span>
        <span className="font-mono text-xs text-popover-foreground">
          {param.format ? param.format(local) : String(local)}
        </span>
      </div>
      <input
        type="range"
        min={param.min}
        max={param.max}
        step={param.step ?? 1}
        value={local}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerUp={(e) => commit(e.currentTarget)}
        onKeyUp={(e) => commit(e.currentTarget)}
        onBlur={(e) => commit(e.currentTarget)}
        aria-label={param.label}
        className="mt-2 h-1 w-full cursor-pointer appearance-none rounded bg-white/15 accent-sky-400"
      />
      {param.hint && <p className={sectionHint}>{param.hint}</p>}
    </div>
  )
}

function BooleanField({
  param,
  value,
  onChange,
}: {
  param: BackgroundBooleanParam
  value: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={sectionLabel}>{param.label}</span>
      <Toggle checked={value} onCheckedChange={onChange} />
    </div>
  )
}

function SelectField({
  param,
  value,
  onChange,
}: {
  param: BackgroundSelectParam
  value: string
  onChange: (value: string) => void
}) {
  const current = param.options.find((option) => option.value === value) ?? param.options[0]
  return (
    <div>
      <span className={sectionLabel}>{param.label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={param.label} className="mt-2">
          <span>{current?.label}</span>
        </SelectTrigger>
        <SelectContent>
          {param.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {param.hint && <p className={sectionHint}>{param.hint}</p>}
    </div>
  )
}

/** Renders the control matching a parameter's declared kind. */
function BackgroundParamField({
  param,
  value,
  onChange,
}: {
  param: BackgroundParam
  value: BackgroundParamValue
  onChange: (value: BackgroundParamValue) => void
}) {
  switch (param.kind) {
    case 'number':
      return (
        <NumberField
          param={param}
          value={typeof value === 'number' ? value : param.default}
          onChange={onChange}
        />
      )
    case 'boolean':
      return (
        <BooleanField
          param={param}
          value={typeof value === 'boolean' ? value : param.default}
          onChange={onChange}
        />
      )
    case 'select':
      return (
        <SelectField
          param={param}
          value={typeof value === 'string' ? value : param.default}
          onChange={onChange}
        />
      )
  }
}

/**
 * Settings screen: Notifications, Actions, and Language preferences.
 */
export default function SettingsView() {
  const { t } = useTranslation()
  const [maxEntries, setMaxEntries] = useAtom(maxEntriesAtom)
  const [autoResolve, setAutoResolve] = useAtom(autoResolveAtom)
  const [background, setBackground] = useAtom(backgroundAtom)
  const [backgroundParams, setBackgroundParams] = useAtom(backgroundParamsAtom)

  const backgroundItems = listBackgrounds().map((definition) => ({
    label: definition.cpu
      ? definition.label
      : `${definition.label} · ${t('settings.backgroundGpuOnly')}`,
    value: definition.id,
  }))

  const definition = getBackground(background)
  const paramDefs = definition?.params ?? []
  const resolvedParams = definition
    ? resolveBackgroundParams(definition, backgroundParams[background])
    : {}

  const setParam = (key: string, value: BackgroundParamValue) => {
    setBackgroundParams((prev) => ({
      ...prev,
      [background]: { ...prev[background], [key]: value },
    }))
  }

  return (
    <div>
      <TabsPrimitive.Root
        defaultValue="notifications"
        orientation="vertical"
        className="flex items-start gap-3"
      >
        <TabsPrimitive.List
          aria-label="Settings sections"
          className="flex w-28 shrink-0 flex-col gap-1"
        >
          <TabsPrimitive.Trigger value="notifications" className={tabBtn}>
            {t('settings.notificationsTab')}
          </TabsPrimitive.Trigger>
          <TabsPrimitive.Trigger value="appearance" className={tabBtn}>
            {t('settings.appearanceTab')}
          </TabsPrimitive.Trigger>
          <TabsPrimitive.Trigger value="actions" className={tabBtn}>
            {t('settings.actionsTab')}
          </TabsPrimitive.Trigger>
          <TabsPrimitive.Trigger value="language" className={tabBtn}>
            {t('settings.language')}
          </TabsPrimitive.Trigger>
        </TabsPrimitive.List>

        <TabsPrimitive.Content value="notifications" className="min-w-0 flex-1">
          <div className={section}>
            <div className="flex items-center justify-between">
              <span className={sectionLabel}>{t('settings.maxMessageHistory')}</span>
              <span className="font-mono text-xs text-popover-foreground">{maxEntries}</span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="range"
                min={10}
                max={9999}
                step={10}
                value={maxEntries}
                onChange={(e) => setMaxEntries(Number(e.target.value))}
                aria-label="Max notification entries"
                className="h-1 flex-1 cursor-pointer appearance-none rounded bg-white/15 accent-sky-400"
              />
            </div>
            <p className={sectionHint}>
              {t('settings.maxMessageHistoryHint')}
            </p>
          </div>
        </TabsPrimitive.Content>

        <TabsPrimitive.Content value="appearance" className="min-w-0 flex-1">
          <div className={section}>
            <div className="flex items-center justify-between">
              <span className={sectionLabel}>{t('settings.background')}</span>
            </div>
            <div className="mt-2">
              <Combobox
                items={backgroundItems}
                value={background}
                onChange={setBackground}
                placeholder={t('settings.background')}
              />
            </div>
            <p className={sectionHint}>{t('settings.backgroundHint')}</p>
            {paramDefs.length > 0 && (
              <div className="mt-3 flex flex-col gap-3 border-t border-white/10 pt-3">
                {paramDefs.map((param) => (
                  <BackgroundParamField
                    key={param.key}
                    param={param}
                    value={resolvedParams[param.key] ?? param.default}
                    onChange={(value) => setParam(param.key, value)}
                  />
                ))}
              </div>
            )}
          </div>
        </TabsPrimitive.Content>

        <TabsPrimitive.Content value="actions" className="min-w-0 flex-1">
          <div className={section}>
            <div className="flex items-center justify-between">
              <span className={sectionLabel}>{t('settings.autoResolveTitle')}</span>
            </div>
            <p className={sectionHint}>
              {t('settings.autoResolveHint')}
            </p>

            <div className="mt-3 divide-y divide-white/5">
              <div className="flex items-center justify-between py-2.5">
                <div className="min-w-0 flex-1">
                  <span className="text-xs text-popover-foreground">{t('plugin.fileBrowser')}</span>
                </div>
                <Toggle
                  checked={autoResolve.filebrowser}
                  onCheckedChange={(v) => setAutoResolve({ ...autoResolve, filebrowser: v })}
                />
              </div>
              <div className="flex items-center justify-between py-2.5">
                <div className="min-w-0 flex-1">
                  <span className="text-xs text-popover-foreground">{t('plugin.viewer')}</span>
                </div>
                <Toggle
                  checked={autoResolve.fileviewer}
                  onCheckedChange={(v) => setAutoResolve({ ...autoResolve, fileviewer: v })}
                />
              </div>
              <div className="flex items-center justify-between py-2.5">
                <div className="min-w-0 flex-1">
                  <span className="text-xs text-popover-foreground">{t('plugin.forward')}</span>
                </div>
                <Toggle
                  checked={autoResolve.forward}
                  onCheckedChange={(v) => setAutoResolve({ ...autoResolve, forward: v })}
                />
              </div>
              <div className="flex items-center justify-between py-2.5">
                <div className="min-w-0 flex-1">
                  <span className="text-xs text-popover-foreground">Git Graph</span>
                </div>
                <Toggle
                  checked={autoResolve.gitgraph}
                  onCheckedChange={(v) => setAutoResolve({ ...autoResolve, gitgraph: v })}
                />
              </div>
              <div className="flex items-center justify-between py-2.5">
                <div className="min-w-0 flex-1">
                  <span className="text-xs text-popover-foreground">{t('plugin.diff')}</span>
                </div>
                <Toggle
                  checked={autoResolve.diff}
                  onCheckedChange={(v) => setAutoResolve({ ...autoResolve, diff: v })}
                />
              </div>
            </div>
          </div>
        </TabsPrimitive.Content>

        <TabsPrimitive.Content value="language" className="min-w-0 flex-1">
          <div className={section}>
            <div className="flex items-center justify-between">
              <span className={sectionLabel}>{t('settings.language')}</span>
            </div>
            <Select value={i18n.language} onValueChange={(v) => i18n.changeLanguage(v)}>
              <SelectTrigger aria-label={t('settings.language')} className="mt-2">
                <span>{i18n.language === 'en' ? t('lang.en') : t('lang.zh_CN')}</span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="en">{t('lang.en')}</SelectItem>
                <SelectItem value="zh_CN">{t('lang.zh_CN')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </TabsPrimitive.Content>
      </TabsPrimitive.Root>
    </div>
  )
}
