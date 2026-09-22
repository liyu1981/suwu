import { useEffect, useMemo, useState } from 'react';
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon } from '../../icons';
import type { StreamChunk } from '../../../lib/stream-parse';

interface Props {
  chunks: StreamChunk[];
  format: 'sse' | 'ndjson' | null;
}

const FORMAT_LABEL: Record<'sse' | 'ndjson', string> = {
  sse: 'Event Stream',
  ndjson: 'JSON Lines Stream',
};

/**
 * Buffered LLM stream viewer: every chunk is rendered inline as clickable
 * tokens; selecting one shows its raw JSON. Adapted from inspect-http-proxy's
 * OpenAI/Ollama stream renderers.
 */
export default function StreamView({ chunks, format }: Props) {
  const [selected, setSelected] = useState(0);
  const [copied, setCopied] = useState(false);

  // Reset to the first chunk when a new stream is parsed.
  useEffect(() => {
    setSelected(0);
  }, [chunks]);

  const active = chunks.length === 0 ? -1 : Math.min(Math.max(selected, 0), chunks.length - 1);
  const chunk = active >= 0 ? chunks[active] : null;
  const prettyJson = useMemo(() => (chunk ? JSON.stringify(chunk.json, null, 2) : ''), [chunk]);

  const copyChunk = async () => {
    if (!chunk) return;
    try {
      await navigator.clipboard.writeText(chunk.raw);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  };

  if (chunks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-white/30">
        No stream chunks found
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Inline tokens — the reconstructed stream text */}
      <div className="min-h-0 flex-1 scrollbar-thin overflow-auto p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="rounded border border-cyan-500/20 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-cyan-300">
            {format ? FORMAT_LABEL[format] : 'LLM Stream'}
          </span>
          <span className="text-[10px] text-white/40">{chunks.length} chunks</span>
          <span className="text-[10px] text-white/30">· click a token to inspect its JSON</span>
        </div>
        <div className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-white/95">
          {chunks.map((item, index) => {
            const isActive = index === active;
            return (
              <span
                key={`${index}-${item.raw.length}`}
                role="button"
                tabIndex={0}
                onClick={() => setSelected(index)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setSelected(index);
                  }
                }}
                title="Click to view this chunk's JSON"
                className={`cursor-pointer whitespace-pre-wrap transition-colors ${
                  isActive
                    ? 'rounded-sm bg-cyan-500/30 text-white underline decoration-2 underline-offset-4'
                    : 'underline decoration-white/25 decoration-1 underline-offset-2 hover:bg-cyan-500/15 hover:text-white'
                }`}
              >
                {item.reasoning && (
                  <span className="rounded-sm bg-white/[0.08] px-0.5 whitespace-pre-wrap text-[11px] italic text-white/70">
                    {item.reasoning}
                  </span>
                )}
                {item.content ? (
                  item.content
                ) : item.reasoning ? null : (
                  <span className="align-middle text-[10px] text-white/35">[meta]</span>
                )}
              </span>
            );
          })}
        </div>
      </div>

      {/* Selected chunk detail */}
      <div className="flex h-[40%] min-h-[132px] shrink-0 flex-col border-t border-white/[0.08]">
        <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.06] px-3 py-1.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-white/40">
            Chunk #{active + 1}
          </span>
          {chunk?.reasoning && <span className="text-[10px] text-white/35">reasoning</span>}
          {chunk?.content && <span className="text-[10px] text-white/35">content</span>}
          <div className="flex-1" />
          <button
            type="button"
            onClick={copyChunk}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-white/50 transition-colors hover:bg-white/[0.06] hover:text-white/90"
          >
            <CopyIcon className="h-3 w-3" />
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button
            type="button"
            onClick={() => setSelected(active - 1)}
            disabled={active <= 0}
            aria-label="Previous chunk"
            title="Previous chunk"
            className="grid h-5 w-5 place-items-center rounded text-white/50 transition-colors hover:bg-white/[0.08] hover:text-white/90 disabled:opacity-25"
          >
            <ChevronLeftIcon className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => setSelected(active + 1)}
            disabled={active >= chunks.length - 1}
            aria-label="Next chunk"
            title="Next chunk"
            className="grid h-5 w-5 place-items-center rounded text-white/50 transition-colors hover:bg-white/[0.08] hover:text-white/90 disabled:opacity-25"
          >
            <ChevronRightIcon className="h-3 w-3" />
          </button>
        </div>
        <pre className="min-h-0 flex-1 scrollbar-thin overflow-auto whitespace-pre p-3 font-mono text-xs text-white/85">
          {prettyJson}
        </pre>
      </div>
    </div>
  );
}
