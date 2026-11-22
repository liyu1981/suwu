/** Shared formatting utilities used across plugin pages. */

/**
 * A human-readable byte count.
 *
 * `zero` is what a zero-byte entry shows: a file list leaves it empty (a 0 B row
 * is noise next to directories), while a settings or upload row wants "0 B" said
 * out loud.
 */
export function formatSize(bytes: number, zero = ''): string {
  if (bytes === 0) return zero;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${i === 0 ? size : size.toFixed(1)} ${units[i]}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function relativeTime(
  when: string | number,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const diff = Date.now() - new Date(when).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return t('notifications.justNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return t('notifications.minutesAgo', { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('notifications.hoursAgo', { count: hr });
  const d = Math.floor(hr / 24);
  return t('notifications.daysAgo', { count: d });
}

export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().trim();
  return h === '' || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
}
