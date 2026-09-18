import type { PatchLine } from './comparison';

export interface SplitRow {
  left: PatchLine | null;
  right: PatchLine | null;
  note?: string;
}

/** Pair whole remove/add runs; notes never consume source line numbers. */
export function alignDiffLines(lines: PatchLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (line.kind === 'context') {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    if (line.kind === 'note') {
      rows.push({ left: null, right: null, note: line.text });
      i++;
      continue;
    }
    const removed: PatchLine[] = [],
      added: PatchLine[] = [],
      notes: string[] = [];
    while (i < lines.length && lines[i].kind !== 'context') {
      const next = lines[i++];
      if (next.kind === 'remove') removed.push(next);
      else if (next.kind === 'add') added.push(next);
      else notes.push(next.text);
    }
    for (let j = 0; j < Math.max(removed.length, added.length); j++)
      rows.push({ left: removed[j] ?? null, right: added[j] ?? null });
    for (const note of notes) rows.push({ left: null, right: null, note });
  }
  return rows;
}

export interface WordSpan {
  text: string;
  highlight: boolean;
}
/** Bounded token LCS: minified lines must not allocate an unbounded matrix. */
export function highlightWords(left: string, right: string): [WordSpan[], WordSpan[]] {
  if (left === right)
    return [[{ text: left, highlight: false }], [{ text: right, highlight: false }]];
  const a = left.match(/\w+|\s+|[^\w\s]/gu) ?? [],
    b = right.match(/\w+|\s+|[^\w\s]/gu) ?? [];
  if (a.length * b.length > 40_000 || left.length + right.length > 16_000)
    return [[{ text: left, highlight: true }], [{ text: right, highlight: true }]];
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] =
        a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const commonA = new Set<number>(),
    commonB = new Set<number>();
  let i = a.length,
    j = b.length;
  while (i && j) {
    if (a[i - 1] === b[j - 1]) {
      commonA.add(--i);
      commonB.add(--j);
    } else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  const spans = (tokens: string[], common: Set<number>): WordSpan[] => {
    const result: WordSpan[] = [];
    tokens.forEach((text, index) => {
      const highlight = !common.has(index),
        prev = result[result.length - 1];
      if (prev && prev.highlight === highlight) prev.text += text;
      else result.push({ text, highlight });
    });
    return result;
  };
  return [spans(a, commonA), spans(b, commonB)];
}
