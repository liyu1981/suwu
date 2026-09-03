import { useState, useCallback, useEffect } from 'react'

export type DialogInputType = 'text' | 'checkbox' | 'select' | 'radio'

export interface DialogInput {
  type: DialogInputType
  name: string
  defaultValue?: string
  options?: { label: string; value: string }[]
  checked?: boolean
  info?: string
}

interface ActionDialogProps {
  title: string
  message: string
  inputs?: DialogInput[]
  actionLabel?: string
  onAction: (values: Record<string, string | boolean>) => void
  onCancel: () => void
}

const inputCls =
  'w-full rounded-lg border border-white/[0.08] bg-white/[0.05] px-3 py-2 text-xs text-white outline-none transition-all duration-150 focus:border-sky-400/40 focus:bg-white/[0.08] focus:ring-1 focus:ring-sky-400/20'

/**
 * Glass-styled confirmation/action dialog matching the file browser's
 * apple design language — rounded-2xl, menu-glass, backdrop-blur-2xl,
 * active:scale-[0.98] on buttons, smooth transitions.
 */
export function ActionDialog({ title, message, inputs = [], actionLabel = 'Confirm', onAction, onCancel }: ActionDialogProps) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => {
    const init: Record<string, string | boolean> = {}
    for (const input of inputs) {
      init[input.name] = input.defaultValue ?? input.checked ?? (input.options?.[0]?.value ?? '')
    }
    return init
  })

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter' && !e.shiftKey && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault()
        onAction(values)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onAction, onCancel, values])

  const set = useCallback((name: string, value: string | boolean) => {
    setValues((prev) => ({ ...prev, [name]: value }))
  }, [])

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-md"
      onClick={onCancel}
    >
      <div
        className="w-[min(90vw,400px)] rounded-2xl border border-white/[0.08] p-4 shadow-2xl menu-glass backdrop-blur-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title */}
        <h3 className="mb-1 text-sm font-semibold tracking-tight text-white/90">{title}</h3>

        {/* Message */}
        <p
          className="mb-4 text-xs leading-relaxed text-white/55"
          dangerouslySetInnerHTML={{ __html: message }}
        />

        {/* Inputs */}
        {inputs.length > 0 && (
          <div className="mb-4 space-y-3">
            {inputs.map((input) => (
              <div key={input.name}>
                {input.type === 'text' && (
                  <div>
                    {input.name && (
                      <label className="mb-1 block text-[11px] font-medium text-white/45">{input.name}</label>
                    )}
                    <input
                      type="text"
                      value={String(values[input.name] ?? '')}
                      onChange={(e) => set(input.name, e.target.value)}
                      autoFocus
                      className={inputCls}
                    />
                  </div>
                )}

                {input.type === 'checkbox' && (
                  <label className="flex items-center gap-2.5 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={!!values[input.name]}
                      onChange={(e) => set(input.name, e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-white/20 bg-white/5 accent-green-500 transition"
                    />
                    <span className="text-xs text-white/65 transition-colors group-hover:text-white/80">{input.name}</span>
                  </label>
                )}

                {input.type === 'select' && input.options && (
                  <div>
                    {input.name && (
                      <label className="mb-1 block text-[11px] font-medium text-white/45">{input.name}</label>
                    )}
                    <select
                      value={String(values[input.name] ?? '')}
                      onChange={(e) => set(input.name, e.target.value)}
                      className={inputCls}
                    >
                      {input.options.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                )}

                {input.type === 'radio' && input.options && (
                  <div className="space-y-2">
                    {input.name && (
                      <label className="block text-[11px] font-medium text-white/45">{input.name}</label>
                    )}
                    {input.options.map((opt) => (
                      <label key={opt.value} className="flex items-center gap-2.5 cursor-pointer group">
                        <input
                          type="radio"
                          name={input.name}
                          value={opt.value}
                          checked={values[input.name] === opt.value}
                          onChange={() => set(input.name, opt.value)}
                          className="h-3.5 w-3.5 border-white/20 bg-white/5 accent-green-500 transition"
                        />
                        <span className="text-xs text-white/65 transition-colors group-hover:text-white/80">{opt.label}</span>
                      </label>
                    ))}
                  </div>
                )}

                {input.info && (
                  <p className="mt-1.5 text-[10px] leading-relaxed text-white/30">{input.info}</p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg bg-white/[0.06] px-3.5 py-1.5 text-xs text-white/50 transition-all duration-150 hover:bg-white/[0.10] hover:text-white/80 active:scale-[0.97]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onAction(values)}
            className="rounded-lg bg-green-500/20 px-3.5 py-1.5 text-xs font-medium text-green-300/90 transition-all duration-150 hover:bg-green-500/30 hover:text-green-200 active:scale-[0.97]"
          >
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
