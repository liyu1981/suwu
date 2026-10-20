/**
 * Formatting helpers for the SFTP tile.
 */

/** Absolute timestamp for the lists: DD/MM/YYYY HH:MM:SS (local time). */
export function formatModTime(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Whether two ISO timestamps are the same instant, allowing a small tolerance
 * for second-precision remote mtimes.
 */
export function sameModTime(a: string, b: string, toleranceMs = 2000): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return Math.abs(ta - tb) <= toleranceMs;
}
