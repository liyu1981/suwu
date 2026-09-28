/** Status dot + label for one job's engine state. */

import { useTranslation } from 'react-i18next';
import type { JobStatus } from '../../lib/foldersync/types';

const DOT: Record<JobStatus, string> = {
  idle: 'bg-white/30',
  starting: 'bg-sky-400',
  preflight: 'bg-sky-400',
  syncing: 'bg-green-400',
  cooldown: 'bg-fuchsia-400',
  error: 'bg-red-500',
};

const PULSE: Record<JobStatus, boolean> = {
  idle: false,
  starting: true,
  preflight: true,
  syncing: true,
  cooldown: false,
  error: false,
};

export function StatusChip({ status, className = '' }: { status: JobStatus; className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span className="relative shrink-0">
        <span className={`block h-2 w-2 rounded-full ${DOT[status]}`} />
        {PULSE[status] && (
          <span
            className={`absolute inset-0 h-2 w-2 animate-pulse rounded-full ${DOT[status]} opacity-40`}
          />
        )}
      </span>
      <span className="text-xs text-white/55">{t(`foldersync.status.${status}`)}</span>
    </span>
  );
}
