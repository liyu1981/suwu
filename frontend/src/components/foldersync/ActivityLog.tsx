/** Per-cycle activity log for one job. Timestamps are Micro, lines Caption. */

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ActivityEvent } from '../../lib/foldersync/types';

const LEVEL_CLASS: Record<ActivityEvent['level'], string> = {
  info: 'text-white/55',
  warn: 'text-amber-300/80',
  error: 'text-red-400/85',
};

function formatTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function ActivityLog({ log }: { log: ActivityEvent[] }) {
  const { t } = useTranslation();
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [log.length]);

  if (log.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-[11px] text-white/35">
        {t('foldersync.logEmpty')}
      </div>
    );
  }

  return (
    <div className="font-mono text-[11px] leading-relaxed">
      {log.map((event, i) => (
        <div key={`${event.at}-${i}`} className="flex gap-2 px-3 py-0.5">
          <span className="shrink-0 text-[10px] tabular-nums text-white/30">
            {formatTime(event.at)}
          </span>
          <span className={`min-w-0 break-all ${LEVEL_CLASS[event.level]}`}>
            {t(event.key, event.params)}
          </span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
