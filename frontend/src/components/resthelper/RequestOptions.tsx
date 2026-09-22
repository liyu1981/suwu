import type { RestOptions, UserAgentMode } from '../../store/resthelper';
import { Select, SelectContent, SelectItem, SelectTrigger } from '../ui/select';

interface Props {
  options: RestOptions;
  patch: (partial: Partial<RestOptions>) => void;
}

const UA_LABELS: Record<UserAgentMode, string> = {
  default: 'Backend default (SuwuREST)',
  browser: 'Replicate this browser',
  custom: 'Custom',
};

const fieldLabel = 'text-[10px] uppercase tracking-wider text-white/30';
const inputClass =
  'w-full rounded-lg border border-white/[0.10] bg-white/[0.03] px-2.5 py-1.5 text-xs text-white/80 outline-none transition-colors focus:border-cyan-400/40';

export default function RequestOptions({ options, patch }: Props) {
  return (
    <div className="flex h-full flex-col gap-4 scrollbar-thin overflow-auto p-1">
      <div className="space-y-1.5">
        <div className={fieldLabel}>User-Agent</div>
        <Select
          value={options.userAgentMode}
          onValueChange={(value) => patch({ userAgentMode: value as UserAgentMode })}
        >
          <SelectTrigger
            aria-label="User-Agent mode"
            className={`${inputClass} h-auto justify-between`}
          >
            <span>{UA_LABELS[options.userAgentMode]}</span>
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(UA_LABELS) as UserAgentMode[]).map((mode) => (
              <SelectItem key={mode} value={mode}>
                {UA_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {options.userAgentMode === 'custom' && (
          <input
            value={options.customUserAgent}
            onChange={(event) => patch({ customUserAgent: event.target.value })}
            placeholder="MyAgent/1.0"
            spellCheck={false}
            className={`${inputClass} font-mono`}
          />
        )}
        <p className="text-[11px] text-white/35">
          An explicit <span className="font-mono">User-Agent</span> header overrides this setting.
        </p>
      </div>

      <div className="space-y-1.5">
        <div className={fieldLabel}>Timeout (ms)</div>
        <input
          type="number"
          min={1000}
          max={300000}
          step={1000}
          value={options.timeoutMs}
          onChange={(event) => patch({ timeoutMs: Number(event.target.value) || 30000 })}
          className={inputClass}
        />
      </div>

      <label className="flex items-center gap-2 text-xs text-white/70">
        <input
          type="checkbox"
          checked={options.followRedirects}
          onChange={(event) => patch({ followRedirects: event.target.checked })}
          className="h-3.5 w-3.5 accent-cyan-500"
        />
        Follow redirects
      </label>

      <label className="flex items-center gap-2 text-xs text-white/70">
        <input
          type="checkbox"
          checked={options.insecureTLS}
          onChange={(event) => patch({ insecureTLS: event.target.checked })}
          className="h-3.5 w-3.5 accent-cyan-500"
        />
        Disable TLS certificate verification
        <span className="text-[10px] text-amber-300/70">(local dev only)</span>
      </label>

      <div className="space-y-2 border-t border-white/[0.06] pt-3">
        <div className={fieldLabel}>Cookies</div>
        <label className="flex items-center gap-2 text-xs text-white/70">
          <input
            type="checkbox"
            checked={options.useCookieJar}
            onChange={(event) => patch({ useCookieJar: event.target.checked })}
            className="h-3.5 w-3.5 accent-cyan-500"
          />
          Send cookies from the jar
        </label>
        <label className="flex items-center gap-2 text-xs text-white/70">
          <input
            type="checkbox"
            checked={options.captureCookies}
            onChange={(event) => patch({ captureCookies: event.target.checked })}
            className="h-3.5 w-3.5 accent-cyan-500"
          />
          Update the jar from responses
        </label>
      </div>
    </div>
  );
}
