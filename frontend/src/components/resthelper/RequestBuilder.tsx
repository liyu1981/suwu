import { useState } from 'react';
import { CopyIcon } from '../icons';
import {
  HTTP_METHODS,
  emptyHeader,
  emptyParam,
  toSendPayload,
  type HttpMethod,
  type RestHeader,
  type RestOptions,
  type RestParam,
  type RestRequestDraft,
} from '../../store/resthelper';
import type { JarCookie } from '../../lib/cookie-jar';
import { generateCurlCommand } from '../../lib/curl-format';
import { Select, SelectContent, SelectItem, SelectTrigger } from '../ui/select';
import BodyEditor from './BodyEditor';
import CookiesPanel from './CookiesPanel';
import KeyValueTable from './KeyValueTable';
import RequestOptions from './RequestOptions';
import { mergeParamsIntoUrl, parseParamsFromUrl } from './url-params';

type BuilderTab = 'params' | 'headers' | 'body' | 'cookies' | 'options';

const TABS: Array<{ id: BuilderTab; label: string }> = [
  { id: 'params', label: 'Params' },
  { id: 'headers', label: 'Headers' },
  { id: 'body', label: 'Body' },
  { id: 'cookies', label: 'Cookies' },
  { id: 'options', label: 'Options' },
];

interface Props {
  draft: RestRequestDraft;
  patch: (partial: Partial<RestRequestDraft>) => void;
  options: RestOptions;
  patchOptions: (partial: Partial<RestOptions>) => void;
  loading: boolean;
  onSend: () => void;
  onCancel: () => void;
  onSave: () => void;
  cookies: JarCookie[];
  targetHost: string;
  currentHost: string;
  onImportBrowser: () => void;
  onImportString: (raw: string) => void;
  onAddCookie: (cookie: JarCookie) => void;
  onRemoveCookie: (id: string) => void;
  onClearCookies: () => void;
}

export default function RequestBuilder({
  draft,
  patch,
  options,
  patchOptions,
  loading,
  onSend,
  onCancel,
  onSave,
  cookies,
  targetHost,
  currentHost,
  onImportBrowser,
  onImportString,
  onAddCookie,
  onRemoveCookie,
  onClearCookies,
}: Props) {
  const [tab, setTab] = useState<BuilderTab>('headers');
  const [copied, setCopied] = useState(false);

  const copyCurl = async () => {
    const payload = toSendPayload(draft, options, navigator.userAgent, '');
    try {
      await navigator.clipboard.writeText(generateCurlCommand(payload));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Method + URL + actions */}
      <div className="flex shrink-0 items-center gap-2 pb-2">
        <Select
          value={draft.method}
          onValueChange={(value) => patch({ method: value as HttpMethod })}
        >
          <SelectTrigger
            aria-label="HTTP method"
            className="h-auto w-[96px] shrink-0 justify-between rounded-lg border-white/[0.10] bg-white/[0.04] px-2 py-1.5 font-mono text-xs font-semibold text-white/80 focus:border-cyan-400/40 focus:ring-0"
          >
            <span>{draft.method}</span>
          </SelectTrigger>
          <SelectContent>
            {HTTP_METHODS.map((method) => (
              <SelectItem key={method} value={method} className="font-mono">
                {method}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <input
          value={draft.url}
          onChange={(event) =>
            patch({ url: event.target.value, params: parseParamsFromUrl(event.target.value) })
          }
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder="https://api.example.com/endpoint or /path"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-white/[0.10] bg-white/[0.03] px-2.5 py-1.5 font-mono text-sm text-white/80 outline-none focus:border-cyan-400/40"
        />
        <button
          type="button"
          onClick={copyCurl}
          title="Copy as cURL"
          aria-label="Copy as cURL"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white/40 transition-colors glass-btn hover:text-white/80"
        >
          <CopyIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onSave}
          className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs text-white/60 transition-colors glass-btn hover:text-white/90"
        >
          Save
        </button>
        {loading ? (
          <button
            type="button"
            onClick={onCancel}
            className="shrink-0 rounded-lg bg-rose-500/25 px-3 py-1.5 text-xs font-medium text-rose-200 transition-all hover:bg-rose-500/35 active:scale-[0.97]"
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={onSend}
            disabled={!draft.url.trim()}
            className="shrink-0 rounded-lg bg-cyan-500/25 px-3 py-1.5 text-xs font-medium text-cyan-200 transition-all hover:bg-cyan-500/35 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-30"
          >
            Send
          </button>
        )}
        {copied && <span className="shrink-0 text-[10px] text-green-400/80">Copied</span>}
      </div>

      {/* Tabs */}
      <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.06] pb-1.5">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
              tab === item.id
                ? 'bg-white/[0.08] text-white/90'
                : 'text-white/40 hover:bg-white/[0.04] hover:text-white/70'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="min-h-0 flex-1 pt-2">
        {tab === 'params' && (
          <KeyValueTable<RestParam>
            rows={draft.params}
            onChange={(params) => patch({ params, url: mergeParamsIntoUrl(draft.url, params) })}
            createRow={() => emptyParam()}
            addLabel="Add param"
            removeLabel="Remove param"
            enableLabel="Enable param"
          />
        )}
        {tab === 'headers' && (
          <KeyValueTable<RestHeader>
            rows={draft.headers}
            onChange={(headers) => patch({ headers })}
            createRow={() => emptyHeader()}
            addLabel="Add header"
            removeLabel="Remove header"
            enableLabel="Enable header"
          />
        )}
        {tab === 'body' && <BodyEditor draft={draft} patch={patch} />}
        {tab === 'cookies' && (
          <CookiesPanel
            cookies={cookies}
            targetHost={targetHost}
            currentHost={currentHost}
            onImportBrowser={onImportBrowser}
            onImportString={onImportString}
            onAdd={onAddCookie}
            onRemove={onRemoveCookie}
            onClearAll={onClearCookies}
          />
        )}
        {tab === 'options' && <RequestOptions options={options} patch={patchOptions} />}
      </div>
    </div>
  );
}
