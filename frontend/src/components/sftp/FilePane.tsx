import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TOOLBAR_BTN } from '../../lib/constants';
import { formatDate, formatSize } from '../../lib/format';
import { ChevronUpIcon, FileIcon, FolderIcon, RefreshIcon, UploadIcon } from '../icons';
import type { EndpointKind, PaneItem } from './api';
import type { SavedSftpConnection } from '../../store/sftp';
import { ConnectionForm } from './ConnectionForm';

/** A pane's connection state, driven by the panel. */
export type PaneState =
  | { kind: 'disconnected' }
  | { kind: 'connecting'; error: string | null }
  | { kind: 'connected' };

/**
 * One side of the SFTP tile. The pane owns its endpoint kind (Suwu / SFTP /
 * browser) and shows its own connection UI when a remote endpoint is not yet
 * connected, so both panes work the same way and either can be a remote.
 */
export function FilePane({
  kind,
  state,
  path,
  entries,
  loading,
  error,
  selected,
  canUp,
  actions,
  savedConnections,
  connecting,
  onKindChange,
  onConnect,
  onDisconnect,
  onForgetConnection,
  onPickBrowserFolder,
  needsBrowserFolder,
  onSelect,
  onOpen,
  onUp,
  onRefresh,
  onDropFiles,
}: {
  kind: EndpointKind;
  state: PaneState;
  path: string;
  entries: PaneItem[];
  loading: boolean;
  error: string | null;
  selected: string | null;
  canUp: boolean;
  actions?: ReactNode;
  savedConnections: SavedSftpConnection[];
  connecting: boolean;
  onKindChange: (kind: EndpointKind) => void;
  onConnect: (params: {
    host: string;
    port?: number;
    user: string;
    auth: 'password' | 'key';
    password?: string;
    privateKey?: string;
    passphrase?: string;
  }) => void;
  onDisconnect: () => void;
  onForgetConnection: (id: string) => void;
  onPickBrowserFolder: () => void;
  /** Browser pane with no folder picked yet. */
  needsBrowserFolder: boolean;
  onSelect: (name: string) => void;
  onOpen: (item: PaneItem) => void;
  onUp: () => void;
  onRefresh: () => void;
  onDropFiles?: (files: File[]) => void;
}) {
  const { t } = useTranslation();
  const [dragOver, setDragOver] = useState(false);

  const tabs: Array<{ kind: EndpointKind; label: string }> = [
    { kind: 'suwu', label: t('sftp.modeSuwu') },
    { kind: 'remote', label: t('sftp.modeRemote') },
    { kind: 'browser', label: t('sftp.modeBrowser') },
  ];

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onDragOver={
        onDropFiles
          ? (e) => {
              e.preventDefault();
              setDragOver(true);
            }
          : undefined
      }
      onDragLeave={onDropFiles ? () => setDragOver(false) : undefined}
      onDrop={
        onDropFiles
          ? (e) => {
              e.preventDefault();
              setDragOver(false);
              onDropFiles(Array.from(e.dataTransfer.files));
            }
          : undefined
      }
    >
      {/* Pane header: endpoint kind tabs, centered */}
      <div className="flex h-10 shrink-0 items-center justify-center border-b border-white/[0.06] px-3">
        <div className="flex gap-0.5 rounded-md bg-white/[0.04] p-0.5">
          {tabs.map((tab) => (
            <button
              key={tab.kind}
              type="button"
              data-active={kind === tab.kind}
              onClick={() => onKindChange(tab.kind)}
              className="rounded px-2 py-1 text-[11px] text-white/50 transition-colors hover:text-white/80 data-[active=true]:bg-white/10 data-[active=true]:text-white/90"
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {kind === 'remote' && state.kind !== 'connected' ? (
        <ConnectionForm
          savedConnections={savedConnections}
          connecting={connecting}
          error={state.kind === 'connecting' ? state.error : null}
          onConnect={onConnect}
          onForget={onForgetConnection}
        />
      ) : kind === 'browser' && needsBrowserFolder ? (
        <div className="grid flex-1 place-items-center p-4">
          <button
            type="button"
            onClick={onPickBrowserFolder}
            className="rounded-lg bg-sky-500/20 px-4 py-2 text-sm text-sky-200 transition-colors hover:bg-sky-500/30"
          >
            {t('sftp.chooseFolder')}
          </button>
        </div>
      ) : (
        <>
          {/* Path / nav row */}
          <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.04] px-2 py-1.5">
            <button
              type="button"
              onClick={onUp}
              disabled={!canUp}
              className={TOOLBAR_BTN}
              title={t('sftp.up')}
            >
              <ChevronUpIcon />
            </button>
            <button
              type="button"
              onClick={onRefresh}
              className={TOOLBAR_BTN}
              title={t('sftp.refresh')}
            >
              <RefreshIcon />
            </button>
            <span
              className="min-w-0 flex-1 truncate px-1 font-mono text-[11px] text-white/40"
              title={path}
            >
              {path}
            </span>
          </div>

          {actions && (
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-white/[0.04] px-2 py-1.5">
              {actions}
            </div>
          )}

          <div className="scrollbar-thin min-h-0 flex-1 overflow-auto">
            {loading && (
              <p className="px-3 py-4 text-center text-xs text-white/30">{t('sftp.loading')}</p>
            )}
            {error && !loading && (
              <p className="px-3 py-4 text-center text-xs text-red-300/80">{error}</p>
            )}
            {!loading && !error && entries.length === 0 && (
              <p className="px-3 py-4 text-center text-xs text-white/25">{t('sftp.emptyDir')}</p>
            )}
            {!error &&
              entries.map((item) => {
                const active = item.name === selected;
                return (
                  <button
                    key={item.name}
                    type="button"
                    onClick={() => onSelect(item.name)}
                    onDoubleClick={() => onOpen(item)}
                    className={`flex w-full items-center gap-2.5 px-3 py-[7px] text-left text-sm transition-colors ${
                      active ? 'bg-sky-500/15 text-white/90' : 'text-white/70 hover:bg-white/[0.04]'
                    }`}
                  >
                    <span className="shrink-0">{item.isDir ? <FolderIcon /> : <FileIcon />}</span>
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    <span className="w-16 shrink-0 text-right text-[11px] text-white/30">
                      {item.isDir ? '' : formatSize(item.size)}
                    </span>
                    <span className="w-20 shrink-0 text-right text-[11px] text-white/25">
                      {item.modTime ? formatDate(item.modTime, t) : ''}
                    </span>
                  </button>
                );
              })}
          </div>
        </>
      )}

      {/* Pane footer: disconnect lives here, never in the tile header */}
      {kind === 'remote' && state.kind === 'connected' && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-white/[0.06] px-3 py-1.5">
          <span className="truncate text-[11px] text-white/35">{path}</span>
          <button
            type="button"
            onClick={onDisconnect}
            className="rounded-md px-2 py-1 text-[11px] text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white/80"
          >
            {t('sftp.disconnect')}
          </button>
        </div>
      )}

      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-md border-2 border-dashed border-sky-400/50 bg-sky-500/10">
          <span className="flex items-center gap-2 text-sm text-sky-200/90">
            <UploadIcon />
            {t('sftp.dropToUpload')}
          </span>
        </div>
      )}
    </div>
  );
}
