import type { CodeFileSpec } from '../../store/notifications';

export interface HighlightRange {
  start: number;
  end: number;
}

/** Parse the `files` URL param (JSON) into validated file specs. */
export function parseFileSpecs(raw: string | null): CodeFileSpec[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const specs: CodeFileSpec[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as { path?: unknown; ranges?: unknown };
    if (typeof candidate.path !== 'string' || candidate.path === '') continue;
    const ranges = Array.isArray(candidate.ranges)
      ? candidate.ranges
          .filter(
            (r): r is { start: number; end: number } =>
              typeof r === 'object' &&
              r !== null &&
              typeof (r as { start?: unknown }).start === 'number' &&
              typeof (r as { end?: unknown }).end === 'number',
          )
          .map((r) => ({ start: r.start, end: r.end }))
      : undefined;
    specs.push({ path: candidate.path, ranges });
  }
  return specs;
}

/**
 * Clamp ranges to the model's line count, drop invalid entries, then sort and
 * merge overlapping or adjacent ranges so each line is only marked once.
 */
export function normalizeRanges(
  ranges: HighlightRange[] | undefined,
  lineCount: number,
): HighlightRange[] {
  if (!ranges || ranges.length === 0 || lineCount <= 0) return [];
  const cleaned: HighlightRange[] = [];
  for (const range of ranges) {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) continue;
    const start = Math.min(Math.max(1, Math.floor(range.start)), lineCount);
    const end = Math.min(Math.max(1, Math.floor(range.end)), lineCount);
    cleaned.push({ start: Math.min(start, end), end: Math.max(start, end) });
  }
  cleaned.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: HighlightRange[] = [];
  for (const range of cleaned) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** Heuristic binary sniff: a NUL byte in the head of the file. */
export function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}
