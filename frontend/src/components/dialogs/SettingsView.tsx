import { useCallback, useEffect, useRef, useState } from 'react'
import { useAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import i18n from 'i18next'
import { Tabs as TabsPrimitive } from 'radix-ui'
import { maxEntriesAtom } from '../../store/notifications'
import { autoResolveAtom, backgroundAtom, backgroundParamsAtom, webgpuBackgroundAtom } from '../../store/settings'
import { Select, SelectTrigger, SelectContent, SelectItem } from '../ui/select'
import { Combobox } from '../ui/combobox'
import { BackgroundPreview, DEFAULT_BACKGROUND_ID, getBackground, listBackgrounds, resolveBackgroundParams, WEBGPU_ENGINE } from '../background'
import type {
  BackgroundBooleanParam,
  BackgroundColorParam,
  BackgroundFileListParam,
  BackgroundNumberParam,
  BackgroundParam,
  BackgroundParamValue,
  BackgroundSelectParam,
  BackgroundStoredFile,
  BackgroundTextParam,
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
      <div className="flex items-center gap-3">
        <span className={`${sectionLabel} shrink-0`}>{param.label}</span>
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
          className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded bg-white/15 accent-sky-400"
        />
        <span className="w-12 shrink-0 text-right font-mono text-xs text-popover-foreground">
          {param.format ? param.format(local) : String(local)}
        </span>
      </div>
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

/** Free-form text/URL input. Commits on blur or Enter. */
function TextField({
  param,
  value,
  onChange,
}: {
  param: BackgroundTextParam
  value: string
  onChange: (value: string) => void
}) {
  const [local, setLocal] = useState(value)
  useEffect(() => setLocal(value), [value])

  // Commit on blur/Enter, not per keystroke: a params change restarts the
  // backend, so typing a URL must not restart it on every character.
  const commit = () => {
    const next = local.trim()
    if (next !== value) onChange(next)
  }

  return (
    <div>
      <span className={sectionLabel}>{param.label}</span>
      <input
        type="url"
        value={local}
        placeholder={param.placeholder}
        maxLength={param.maxLength}
        spellCheck={false}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        aria-label={param.label}
        className="mt-2 h-8 w-full rounded border border-white/10 bg-black/30 px-2 text-xs text-popover-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-sky-400/60 focus:ring-1 focus:ring-sky-400/30"
      />
      {param.hint && <p className={sectionHint}>{param.hint}</p>}
    </div>
  )
}

/** Human-readable file size. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value >= 10 || Number.isInteger(value) ? 0 : 1)} ${units[unit]}`
}

/**
 * Library of persisted files: thumbnail, name and size per entry, with
 * Use/Clear actions and an Add button. The selected id is the stored value.
 */
function FileListField({
  param,
  value,
  onChange,
}: {
  param: BackgroundFileListParam
  value: string
  onChange: (value: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<BackgroundStoredFile[]>([])
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setFiles(await param.list())
      setError(null)
    } catch (listError) {
      setError(listError instanceof Error ? listError.message : String(listError))
    } finally {
      setLoading(false)
    }
  }, [param])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Object URLs for the thumbnails, revoked when the list changes/unmounts.
  useEffect(() => {
    const urls: Record<string, string> = {}
    for (const file of files) {
      if (file.thumbnail) urls[file.id] = URL.createObjectURL(file.thumbnail)
    }
    setThumbUrls(urls)
    return () => {
      for (const url of Object.values(urls)) URL.revokeObjectURL(url)
    }
  }, [files])

  const add = async (list: FileList | null): Promise<void> => {
    const file = list?.[0]
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const id = await param.store(file)
      onChange(id)
      await refresh()
    } catch (storeError) {
      setError(storeError instanceof Error ? storeError.message : String(storeError))
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const remove = async (id: string): Promise<void> => {
    setBusy(true)
    try {
      await param.clear(id)
      if (value === id) onChange('')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const button =
    'shrink-0 rounded border border-white/10 bg-black/30 px-2 py-1 text-xs outline-none ' +
    'transition-colors hover:bg-white/10 focus-visible:ring-1 focus-visible:ring-sky-400/60 ' +
    'disabled:cursor-not-allowed disabled:opacity-40'

  return (
    <div>
      <div className="flex items-center justify-between">
        <span className={sectionLabel}>{param.label}</span>
        <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} className={button}>
          {busy ? 'Working…' : 'Add file…'}
        </button>
      </div>

      <div className="mt-2 space-y-1.5">
        {loading && (
          <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">Loading…</p>
        )}
        {!loading && files.length === 0 && (
          <p className="rounded border border-dashed border-white/10 px-2 py-3 text-center text-[11px] text-muted-foreground">
            No clips stored yet.
          </p>
        )}
        {files.map((file) => {
          const active = file.id === value
          return (
            <div
              key={file.id}
              className={`flex items-center gap-2 rounded border p-1.5 ${
                active ? 'border-sky-400/50 bg-sky-400/10' : 'border-white/10 bg-black/20'
              }`}
            >
              <div className="h-10 w-16 shrink-0 overflow-hidden rounded bg-black/40">
                {thumbUrls[file.id] ? (
                  <img src={thumbUrls[file.id]} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="grid h-full w-full place-items-center text-[9px] text-white/30">no preview</div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-popover-foreground" title={file.name}>
                  {file.name}
                </div>
                <div className="text-[11px] text-muted-foreground">{formatSize(file.size)}</div>
              </div>
              <button
                type="button"
                onClick={() => onChange(file.id)}
                disabled={busy || active}
                className={`${button} ${active ? 'text-sky-300' : ''}`}
              >
                {active ? 'In use' : 'Use'}
              </button>
              <button
                type="button"
                onClick={() => void remove(file.id)}
                disabled={busy}
                className={`${button} text-red-300 hover:bg-red-500/15`}
              >
                Clear
              </button>
            </div>
          )
        })}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={param.accept}
        className="hidden"
        onChange={(e) => void add(e.target.files)}
      />
      {param.hint && <p className={sectionHint}>{param.hint}</p>}
      {error && <p className="mt-1 text-[11px] text-red-400">{error}</p>}
    </div>
  )
}

/** Colour picker; commits on blur so dragging the picker doesn't thrash the backend. */
function ColorField({
  param,
  value,
  onChange,
}: {
  param: BackgroundColorParam
  value: string
  onChange: (value: string) => void
}) {
  const [local, setLocal] = useState(value)
  useEffect(() => setLocal(value), [value])
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <span className={`${sectionLabel} shrink-0`}>{param.label}</span>
        <div className="flex items-center gap-2">
          <label
            className="relative block h-5 w-8 cursor-pointer overflow-hidden rounded border border-white/15"
            title={param.label}
          >
            <span className="absolute inset-0" style={{ backgroundColor: local }} />
            <input
              type="color"
              value={local}
              onChange={(e) => setLocal(e.target.value)}
              onBlur={() => {
                if (local !== value) onChange(local)
              }}
              aria-label={param.label}
              className="absolute inset-0 cursor-pointer opacity-0"
            />
          </label>
          <span className="font-mono text-xs text-popover-foreground">{local}</span>
        </div>
      </div>
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
    case 'text':
      return (
        <TextField
          param={param}
          value={typeof value === 'string' ? value : param.default}
          onChange={onChange}
        />
      )
    case 'fileList':
      return (
        <FileListField
          param={param}
          value={typeof value === 'string' ? value : param.default}
          onChange={onChange}
        />
      )
    case 'color':
      return (
        <ColorField
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
  const [webgpuBackground, setWebgpuBackground] = useAtom(webgpuBackgroundAtom)

  const definitions = listBackgrounds()
  const engineDefinitions = definitions.filter((d) => d.engine === WEBGPU_ENGINE)
  const otherDefinitions = definitions.filter((d) => d.engine !== WEBGPU_ENGINE)

  // A stale stored id falls back to the default, matching the shell.
  const definition = getBackground(background) ?? getBackground(DEFAULT_BACKGROUND_ID)
  const activeId = definition?.id ?? DEFAULT_BACKGROUND_ID
  const inWebgpu = definition?.engine === WEBGPU_ENGINE

  // The primary selector picks a background family; "WebGPU" reveals a second
  // selector for the engine-backed backgrounds that are currently registered.
  const familyItems = [
    ...otherDefinitions.map((d) => ({ label: d.label, value: d.id })),
    { label: t('settings.backgroundWebgpu'), value: WEBGPU_ENGINE },
  ]
  const engineItems = engineDefinitions.map((d) => ({ label: d.label, value: d.id }))

  const selectFamily = (value: string) => {
    if (value !== WEBGPU_ENGINE) {
      setBackground(value)
      return
    }
    // Enter the WebGPU group: restore the last engine background, else the first.
    const remembered = engineDefinitions.find((d) => d.id === webgpuBackground)?.id
    const next = remembered ?? engineDefinitions[0]?.id
    if (next) {
      setBackground(next)
      setWebgpuBackground(next)
    }
  }

  const selectEngineBackground = (id: string) => {
    setBackground(id)
    setWebgpuBackground(id)
  }

  const paramDefs = definition?.params ?? []
  const resolvedParams = definition
    ? resolveBackgroundParams(definition, backgroundParams[activeId])
    : {}

  const setParam = (key: string, value: BackgroundParamValue) => {
    setBackgroundParams((prev) => ({
      ...prev,
      [activeId]: { ...prev[activeId], [key]: value },
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
              <BackgroundPreview background={activeId} />
            </div>
            <div className="mt-2">
              <Combobox
                items={familyItems}
                value={inWebgpu ? WEBGPU_ENGINE : activeId}
                onChange={selectFamily}
                placeholder={t('settings.background')}
              />
            </div>
            {inWebgpu && (
              <div className="mt-2">
                <Combobox
                  items={engineItems}
                  value={activeId}
                  onChange={selectEngineBackground}
                  placeholder={t('settings.backgroundWebgpu')}
                />
              </div>
            )}
            <p className={sectionHint}>
              {inWebgpu ? t('settings.backgroundWebgpuHint') : t('settings.backgroundHint')}
            </p>
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
              <div className="flex items-center justify-between py-2.5">
                <div className="min-w-0 flex-1">
                  <span className="text-xs text-popover-foreground">{t('plugin.code')}</span>
                </div>
                <Toggle
                  checked={autoResolve.code}
                  onCheckedChange={(v) => setAutoResolve({ ...autoResolve, code: v })}
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
