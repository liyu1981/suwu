import { useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import { CheckIcon, CopyIcon, TrashIcon } from '../icons';
import { MONACO_THEME, ensureMonacoTheme } from '../codeexplorer/monacoSetup';
import {
  contentTypeOf,
  decodeBase64ToBytes,
  decodeBase64ToText,
  formatBytes,
  isBinaryContentType,
  isJsonContentType,
} from '../../lib/http-body';
import { generateLLMMarkdown } from '../../lib/llm-format';
import { parseStreamBody } from '../../lib/stream-parse';
import StreamView from './renderers/StreamView';
import type { RestResponseData, RestSendPayload } from '../../store/resthelper';

type BodyView = 'auto' | 'plain' | 'raw' | 'json' | 'llm' | 'stream';
type ResponseTab = 'body' | 'llm' | 'status' | 'headers' | 'request';

const BODY_VIEWS: Array<{ id: BodyView; label: string }> = [
  { id: 'auto', label: 'Auto' },
  { id: 'plain', label: 'Plain' },
  { id: 'raw', label: 'Raw' },
  { id: 'json', label: 'JSON' },
  { id: 'llm', label: 'LLM' },
];

const TABS: Array<{ id: ResponseTab; label: string }> = [
  { id: 'body', label: 'Body' },
  { id: 'llm', label: 'LLM' },
  { id: 'status', label: 'Status' },
  { id: 'headers', label: 'Headers' },
  { id: 'request', label: 'Request' },
];

interface Props {
  response: RestResponseData | null;
  request: RestSendPayload | null;
  loading: boolean;
}

function statusColor(status: number): string {
  if (status === 0) return 'text-rose-400';
  if (status < 300) return 'text-green-400';
  if (status < 400) return 'text-cyan-400';
  if (status < 500) return 'text-amber-400';
  return 'text-rose-400';
}

function detectView(contentType: string, hasStream: boolean): BodyView {
  if (hasStream) return 'stream';
  if (isJsonContentType(contentType)) return 'json';
  return 'plain';
}

export default function ResponseViewer({ response, request, loading }: Props) {
  const [tab, setTab] = useState<ResponseTab>('body');
  const [view, setView] = useState<BodyView>('auto');
  const [copied, setCopied] = useState(false);

  const contentType = response ? contentTypeOf(response.headers) : '';
  const text = useMemo(
    () => (response && !response.error ? decodeBase64ToText(response.bodyB64) : ''),
    [response],
  );
  const stream = useMemo(() => parseStreamBody(text, contentType), [text, contentType]);
  const bodyViews = useMemo<Array<{ id: BodyView; label: string }>>(
    () =>
      stream.chunks.length > 0
        ? [BODY_VIEWS[0], { id: 'stream', label: 'Stream' }, ...BODY_VIEWS.slice(1)]
        : BODY_VIEWS,
    [stream],
  );
  let effectiveView: BodyView =
    view === 'auto' ? detectView(contentType, stream.chunks.length > 0) : view;
  if (effectiveView === 'stream' && stream.chunks.length === 0) {
    effectiveView = detectView(contentType, false);
  }

  const prettyJson = useMemo(() => {
    if (effectiveView !== 'json') return '';
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }, [effectiveView, text]);

  const llmMarkdown = useMemo(
    () => (response && request ? generateLLMMarkdown(request, response) : ''),
    [response, request],
  );

  const copyText = async (value: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  };

  const download = () => {
    if (!response) return;
    const bytes = decodeBase64ToBytes(response.bodyB64);
    const blob = new Blob([bytes as BlobPart], { type: contentType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `response-${Date.now()}.bin`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const showEmpty = !response && !loading;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-2 pb-2">
        {response && (
          <span className={`font-mono text-xs font-semibold ${statusColor(response.status)}`}>
            {response.status === 0 ? 'ERROR' : `${response.status} ${response.statusText}`.trim()}
          </span>
        )}
        {response && (
          <span className="text-[10px] text-white/35">
            {response.durationMs} ms · {formatBytes(response.bodySize)}
            {response.truncated ? ' · truncated' : ''}
          </span>
        )}
        <div className="flex-1" />
        {response && (
          <>
            <button
              type="button"
              onClick={() => copyText(text)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-white/50 transition-colors hover:bg-white/[0.06] hover:text-white/80"
            >
              {copied ? <CheckIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
              Copy
            </button>
            <button
              type="button"
              onClick={download}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-white/50 transition-colors hover:bg-white/[0.06] hover:text-white/80"
            >
              <TrashIcon className="h-3 w-3 rotate-180" />
              Download
            </button>
          </>
        )}
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
        <div className="flex-1" />
        {tab === 'body' && response && !response.error && (
          <div className="flex items-center gap-0.5">
            {bodyViews.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setView(item.id)}
                className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                  effectiveView === item.id
                    ? 'bg-cyan-500/20 text-cyan-200'
                    : 'text-white/35 hover:text-white/70'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 pt-2">
        {showEmpty && !loading && (
          <div className="flex h-full items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.02] text-[11px] text-white/25">
            Send a request to see the response
          </div>
        )}

        {loading && (
          <div className="flex h-full animate-pulse items-center justify-center rounded-lg border border-white/[0.06] bg-white/[0.02] text-[11px] text-white/40">
            Waiting for response…
          </div>
        )}

        {response && !loading && tab === 'body' && (
          <div className="h-full rounded-lg border border-white/[0.06] bg-white/[0.02]">
            {effectiveView === 'stream' ? (
              <StreamView chunks={stream.chunks} format={stream.format} />
            ) : (
              <div className="h-full scrollbar-thin overflow-auto">
                {renderBody(response, effectiveView, { text, prettyJson, contentType })}
              </div>
            )}
          </div>
        )}

        {response && !loading && tab === 'llm' && (
          <div className="flex h-full min-h-0 flex-col gap-2">
            <button
              type="button"
              onClick={() => copyText(llmMarkdown)}
              className="self-start rounded-md bg-cyan-500/20 px-2.5 py-1 text-xs text-cyan-200 transition-colors hover:bg-cyan-500/30"
            >
              {copied ? 'Copied' : 'Copy for LLM'}
            </button>
            <pre className="min-h-0 flex-1 scrollbar-thin overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 font-mono text-xs text-white/70">
              {llmMarkdown}
            </pre>
          </div>
        )}

        {response && !loading && tab === 'status' && <StatusView response={response} />}
        {response && !loading && tab === 'headers' && <HeadersView headers={response.headers} />}
        {response && !loading && tab === 'request' && request && (
          <RequestDetails request={request} />
        )}
      </div>
    </div>
  );
}

function renderBody(
  response: RestResponseData,
  view: BodyView,
  ctx: { text: string; prettyJson: string; contentType: string },
) {
  if (response.error) {
    return (
      <div className="p-3">
        <div className="mb-2 text-xs font-semibold text-rose-300">
          Transport error ({response.errorKind ?? 'other'})
        </div>
        <pre className="whitespace-pre-wrap font-mono text-[11px] text-rose-200/80">
          {response.error}
        </pre>
      </div>
    );
  }

  if (response.bodySize === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-white/25">
        Empty response body
      </div>
    );
  }

  if (response.bodyOmitted) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center">
        <div className="text-xs font-semibold text-amber-300">Response body not stored</div>
        <div className="text-[11px] text-white/45">
          {formatBytes(response.bodySize)} exceeded the storage limit. Re-send the request to view
          it.
        </div>
      </div>
    );
  }

  if (view === 'auto' && isBinaryContentType(ctx.contentType)) {
    if (/image\//i.test(ctx.contentType)) {
      return (
        <div className="flex h-full items-center justify-center p-4">
          <img
            src={`data:${ctx.contentType};base64,${response.bodyB64}`}
            alt="Response preview"
            className="max-h-full max-w-full rounded-md"
          />
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-white/30">
        Binary response ({formatBytes(response.bodySize)}). Use Download.
      </div>
    );
  }

  if (view === 'json') {
    return (
      <Editor
        defaultLanguage="json"
        theme={MONACO_THEME}
        value={ctx.prettyJson}
        onMount={(_editor, monaco) => ensureMonacoTheme(monaco)}
        options={{
          readOnly: true,
          minimap: { enabled: false },
          fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
          fontSize: 13,
          lineNumbers: 'off',
          folding: true,
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          automaticLayout: true,
          padding: { top: 8, bottom: 8 },
          scrollbar: {
            vertical: 'auto',
            horizontal: 'auto',
            verticalScrollbarSize: 6,
            horizontalScrollbarSize: 6,
          },
        }}
      />
    );
  }

  return (
    <pre
      className={`p-3 font-mono text-xs text-white/75 ${
        view === 'raw' ? 'whitespace-pre' : 'whitespace-pre-wrap break-words'
      }`}
    >
      {ctx.text}
    </pre>
  );
}

function StatusView({ response }: { response: RestResponseData }) {
  const isHttps = response.finalUrl.startsWith('https');
  return (
    <div className="flex flex-col gap-2 scrollbar-thin overflow-auto">
      <div className="grid grid-cols-3 gap-2">
        <Stat
          label="Status"
          value={
            response.status === 0 ? 'ERROR' : `${response.status} ${response.statusText}`.trim()
          }
        />
        <Stat label="Time" value={`${response.durationMs} ms`} />
        <Stat label="Size" value={formatBytes(response.bodySize)} />
        <Stat label="Protocol" value={isHttps ? 'HTTPS' : 'HTTP'} />
        <Stat label="TLS verify" value={response.insecureTLS ? 'disabled' : 'enabled'} />
        <Stat label="Redirects" value={String((response.redirects ?? []).length)} />
      </div>
      {response.error && (
        <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-3 text-[11px] text-rose-200/80">
          <div className="font-semibold">{response.errorKind ?? 'error'}</div>
          <div className="font-mono">{response.error}</div>
        </div>
      )}
      {(response.redirects ?? []).length > 0 && (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-white/30">
            Redirect chain
          </div>
          <ol className="space-y-0.5 font-mono text-[11px] text-white/50">
            {(response.redirects ?? []).map((url) => (
              <li key={url} className="truncate">
                {url}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2">
      <div className="text-[10px] uppercase tracking-wider text-white/30">{label}</div>
      <div className="truncate font-mono text-xs text-white/75">{value}</div>
    </div>
  );
}

function HeadersView({ headers }: { headers: Record<string, string[]> }) {
  const entries = Object.entries(headers);
  if (entries.length === 0) {
    return <div className="text-[11px] text-white/30">No response headers</div>;
  }
  return (
    <div className="scrollbar-thin overflow-auto rounded-lg border border-white/[0.08]">
      {entries.map(([key, values]) => (
        <div
          key={key}
          className="flex gap-3 border-b border-white/[0.04] px-2 py-1.5 last:border-0"
        >
          <span className="w-44 shrink-0 truncate font-mono text-xs text-cyan-300/80">{key}</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11px] text-white/55">
            {values.join('\n')}
          </span>
        </div>
      ))}
    </div>
  );
}

function RequestDetails({ request }: { request: RestSendPayload }) {
  const resolvedUA =
    request.userAgentMode === 'browser'
      ? request.browserUserAgent
      : request.userAgentMode === 'custom'
        ? request.customUserAgent
        : 'SuwuREST (backend default)';
  return (
    <div className="space-y-3 scrollbar-thin overflow-auto">
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2">
        <div className="text-[10px] uppercase tracking-wider text-white/30">Endpoint</div>
        <div className="break-all font-mono text-xs text-white/70">
          <span className="mr-2 font-semibold text-cyan-300/90">{request.method}</span>
          {request.url}
        </div>
      </div>
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2">
        <div className="text-[10px] uppercase tracking-wider text-white/30">
          Resolved User-Agent
        </div>
        <div className="break-all font-mono text-[11px] text-white/60">{resolvedUA}</div>
      </div>
      <div className="rounded-lg border border-white/[0.08]">
        <div className="border-b border-white/[0.06] px-2 py-1 text-[10px] uppercase tracking-wider text-white/30">
          Request headers
        </div>
        {request.headers.length === 0 ? (
          <div className="p-2 text-[11px] text-white/30">No headers</div>
        ) : (
          request.headers.map((header) => (
            <div
              key={`${header.key}:${header.value}`}
              className="flex gap-3 border-b border-white/[0.04] px-2 py-1.5 last:border-0"
            >
              <span className="w-44 shrink-0 truncate font-mono text-xs text-cyan-300/80">
                {header.key}
              </span>
              <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-white/55">
                {header.value}
              </span>
            </div>
          ))
        )}
      </div>
      {request.body && request.bodyType !== 'none' && (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-white/30">Payload</div>
          <pre className="max-h-48 scrollbar-thin overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-white/60">
            {request.body}
          </pre>
        </div>
      )}
    </div>
  );
}
