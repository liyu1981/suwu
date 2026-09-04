/**
 * DiffPage — Side-by-side diff viewer with inline word diff.
 *
 * Layout:
 *   Row 1: toolbar (label + file names)
 *   Row 2: side-by-side diff panels (left = file1, right = file2)
 *
 * Changed lines are paired (remove ↔ add) and word-level differences
 * are highlighted within each line.
 *
 * Zoom: tileZoomStyle compensates for CSS zoom so the page fills the
 * iframe exactly — bigger zoom means bigger UI with no scrollbars.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CommonTileContainer } from '../components/CommonTileContainer';
import { useAtomValue } from 'jotai';
import { diffFontFamilyAtom, fileBrowserBgAtom } from '../store/appearance';
import { diffZoomAtom } from '../store/zoom';
import { fetchJson } from '../lib/format';
import { setPageTransparent } from '../lib/constants';

/* ── Types ─────────────────────────────────────────────────────── */

interface DiffLine {
  left: string | null;
  right: string | null;
  type: 'context' | 'add' | 'remove' | 'hunk';
  /** When paired, the index of the opposite-side line in the parsed array. */
  pairIdx?: number;
}

interface DiffResult {
  diff: string;
  file1: string;
  file2: string;
}

/** A single styled span for inline rendering. */
interface WordSpan {
  text: string;
  highlight: boolean;
}

/* ── Word-level diff (LCS on words) ────────────────────────────── */

function tokenize(s: string): string[] {
  return s.match(/\S+|\s+/g) ?? [];
}

function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp;
}

function wordDiff(oldLine: string, newLine: string): [WordSpan[], WordSpan[]] {
  const a = tokenize(oldLine);
  const b = tokenize(newLine);

  if (oldLine === newLine) {
    return [
      [{ text: oldLine, highlight: false }],
      [{ text: newLine, highlight: false }],
    ];
  }

  const dp = lcsTable(a, b);

  const commonA = new Set<number>();
  const commonB = new Set<number>();
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      commonA.add(i - 1);
      commonB.add(j - 1);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  const buildSpans = (tokens: string[], common: Set<number>): WordSpan[] => {
    const spans: WordSpan[] = [];
    let buf = '';
    let bufHL = false;
    for (let k = 0; k < tokens.length; k++) {
      const hl = !common.has(k);
      if (hl !== bufHL && buf.length > 0) {
        spans.push({ text: buf, highlight: bufHL });
        buf = '';
      }
      buf += tokens[k];
      bufHL = hl;
    }
    if (buf.length > 0) spans.push({ text: buf, highlight: bufHL });
    return spans;
  };

  return [buildSpans(a, commonA), buildSpans(b, commonB)];
}

/* ── Diff parsing ──────────────────────────────────────────────── */

function parseDiff(raw: string): DiffLine[] {
  const lines = raw.split('\n');
  const result: DiffLine[] = [];

  for (const line of lines) {
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('diff ') || line.startsWith('index ')) {
      continue;
    }
    if (line.startsWith('@@')) {
      result.push({ left: line, right: line, type: 'hunk' });
      continue;
    }

    if (line.startsWith('+')) {
      result.push({ left: null, right: line.slice(1), type: 'add' });
    } else if (line.startsWith('-')) {
      result.push({ left: line.slice(1), right: null, type: 'remove' });
    } else {
      const content = line.startsWith(' ') ? line.slice(1) : line;
      result.push({ left: content, right: content, type: 'context' });
    }
  }

  // Pair consecutive remove → add lines for word diff.
  for (let i = 0; i < result.length - 1; i++) {
    if (result[i].type === 'remove' && result[i + 1].type === 'add') {
      result[i].pairIdx = i + 1;
      result[i + 1].pairIdx = i;
    }
  }

  return result;
}

/* ── Helpers ───────────────────────────────────────────────────── */



/* ── Inline word-diff renderer ─────────────────────────────────── */

function WordDiffLine({ text, pairedText, side }: { text: string; pairedText: string | null; side: 'left' | 'right' }) {
  const spans = useMemo(() => {
    if (pairedText === null) return [{ text, highlight: false }];
    const [leftSpans, rightSpans] = wordDiff(
      side === 'left' ? text : pairedText,
      side === 'left' ? pairedText : text,
    );
    return side === 'left' ? leftSpans : rightSpans;
  }, [text, pairedText, side]);

  return (
    <>
      {spans.map((s, i) =>
        s.highlight ? (
          <mark key={i} className="bg-amber-300/15 text-amber-100/80 rounded-sm px-0">{s.text}</mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

/* ── Component ─────────────────────────────────────────────────── */

export default function DiffPage() {
  const bgColor = useAtomValue(fileBrowserBgAtom);
  const diffFontFamily = useAtomValue(diffFontFamilyAtom);

  const urlParams = new URLSearchParams(window.location.search);
  const file1Param = urlParams.get('file1') ?? urlParams.get('file1path');
  const file2Param = urlParams.get('file2') ?? urlParams.get('file2path');

  const [result, setResult] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Scroll sync between left and right panes
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  const onLeftScroll = useCallback(() => {
    if (syncing.current || !leftRef.current || !rightRef.current) return;
    syncing.current = true;
    rightRef.current.scrollTop = leftRef.current.scrollTop;
    syncing.current = false;
  }, []);

  const onRightScroll = useCallback(() => {
    if (syncing.current || !leftRef.current || !rightRef.current) return;
    syncing.current = true;
    leftRef.current.scrollTop = rightRef.current.scrollTop;
    syncing.current = false;
  }, []);

  useEffect(() => {
    if (!file1Param || !file2Param) {
      setError('Missing file1 or file2 parameters');
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ file1: file1Param, file2: file2Param });
    fetchJson<DiffResult>(`/api/file/diff?${params}`)
      .then((d) => { if (!cancelled) setResult(d); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load diff'); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [file1Param, file2Param]);

  useEffect(() => {
    setPageTransparent();
  }, []);

  const parsed = useMemo(() => (result ? parseDiff(result.diff) : []), [result]);
  const addCount = parsed.filter((l) => l.type === 'add').length;
  const removeCount = parsed.filter((l) => l.type === 'remove').length;

  const fileName1 = file1Param ? file1Param.split('/').pop() ?? file1Param : '—';
  const fileName2 = file2Param ? file2Param.split('/').pop() ?? file2Param : '—';

  return (
    <CommonTileContainer zoomAtom={diffZoomAtom} noPadding>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">

        {/* Row 1 — toolbar */}
        <div className="flex h-8 shrink-0 items-center gap-2 rounded-t-[6px] border-b border-white/10 px-3 py-1.5 glass-control">
          <span className="text-[11px] font-semibold tracking-wide text-white/60">Diff</span>
          <div className="ml-2 flex items-center gap-1.5 text-[10px] text-white/40">
            <span className="truncate max-w-[200px]">{fileName1}</span>
            <span className="text-white/20">↔</span>
            <span className="truncate max-w-[200px]">{fileName2}</span>
          </div>
          {result && (
            <div className="ml-auto flex items-center gap-2 font-mono text-[10px]">
              <span className="text-green-400">+{addCount}</span>
              <span className="text-red-400">−{removeCount}</span>
            </div>
          )}
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex flex-1 items-center justify-center rounded-b-[6px] border-x border-b border-white/[0.10] bg-black/20">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
          </div>
        ) : error ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-b-[6px] border-x border-b border-white/[0.10] bg-black/20 p-6">
            <svg className="h-8 w-8 text-red-400" viewBox="0 0 16 16" fill="currentColor"><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575L6.457 1.047zM8 5.5a.75.75 0 0 0-.75.75v3a.75.75 0 1 0 1.5 0v-3A.75.75 0 0 0 8 5.5zm0 6.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/></svg>
            <div className="max-w-sm text-center text-red-300">{error}</div>
          </div>
        ) : parsed.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-b-[6px] border-x border-b border-white/[0.10] bg-black/20 p-6">
            <div className="text-white/60">Files are identical — no differences.</div>
          </div>
        ) : (
          /* Side-by-side diff */
          <div className="min-h-0 flex-1 flex rounded-b-[6px] border-x border-b border-x-white/[0.10] border-b-white/[0.10] bg-black/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
            {/* Left panel — file1 */}
            <div className="min-w-0 flex-1 flex flex-col border-r border-white/[0.06]" style={{ backgroundColor: bgColor }}>
              <div className="flex items-center border-b border-white/[0.06] bg-white/[0.03] px-3 py-1">
                <span className="text-[10px] font-medium text-white/50 truncate">{fileName1}</span>
                <span className="ml-2 text-[10px] text-red-400/60">old</span>
              </div>
              <div ref={leftRef} onScroll={onLeftScroll} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin" style={{ fontFamily: diffFontFamily, lineHeight: 1.6 }}>
                {parsed.map((line, i) => {
                  let cls = 'text-white/50';
                  if (line.type === 'remove') cls = 'bg-rose-400/[0.06] text-rose-200/60';
                  else if (line.type === 'hunk') cls = 'bg-sky-400/[0.06] text-sky-200/50';
                  else if (line.type === 'add') cls = 'bg-white/[0.015] text-white/15';

                  const content = line.left ?? '';
                  const pairedText = line.pairIdx !== undefined ? parsed[line.pairIdx].right ?? parsed[line.pairIdx].left : null;

                  return (
                    <div key={`l-${i}`} className={`flex ${cls}`}>
                      <span className="w-10 shrink-0 select-none border-r border-white/[0.06] px-1.5 text-right text-white/20" />
                      <span className="flex-1 whitespace-pre-wrap break-all px-2">
                        {line.type === 'remove' && pairedText !== null ? (
                          <WordDiffLine text={content} pairedText={pairedText} side="left" />
                        ) : (
                          content || ' '
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right panel — file2 */}
            <div className="min-w-0 flex-1 flex flex-col" style={{ backgroundColor: bgColor }}>
              <div className="flex items-center border-b border-white/[0.06] bg-white/[0.03] px-3 py-1">
                <span className="text-[10px] font-medium text-white/50 truncate">{fileName2}</span>
                <span className="ml-2 text-[10px] text-green-400/60">new</span>
              </div>
              <div ref={rightRef} onScroll={onRightScroll} className="min-h-0 flex-1 overflow-y-auto scrollbar-thin" style={{ fontFamily: diffFontFamily, lineHeight: 1.6 }}>
                {parsed.map((line, i) => {
                  let cls = 'text-white/50';
                  if (line.type === 'add') cls = 'bg-emerald-400/[0.06] text-emerald-200/60';
                  else if (line.type === 'hunk') cls = 'bg-sky-400/[0.06] text-sky-200/50';
                  else if (line.type === 'remove') cls = 'bg-white/[0.015] text-white/15';

                  const content = line.right ?? '';
                  const pairedText = line.pairIdx !== undefined ? parsed[line.pairIdx].left ?? parsed[line.pairIdx].right : null;

                  return (
                    <div key={`r-${i}`} className={`flex ${cls}`}>
                      <span className="w-10 shrink-0 select-none border-r border-white/[0.06] px-1.5 text-right text-white/20" />
                      <span className="flex-1 whitespace-pre-wrap break-all px-2">
                        {line.type === 'add' && pairedText !== null ? (
                          <WordDiffLine text={content} pairedText={pairedText} side="right" />
                        ) : (
                          content || ' '
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </CommonTileContainer>
  );
}
