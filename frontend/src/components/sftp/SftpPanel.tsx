import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { CommonTileContainer } from '../CommonTileContainer';
import { DENSE_TILE_BG } from '../../store/appearance';
import { sftpZoomAtom } from '../../store/zoom';
import {
  sftpSavedConnectionsAtom,
  upsertSavedConnection,
  type SavedSftpConnection,
} from '../../store/sftp';
import { PlusIcon, SwapIcon, TrashIcon } from '../icons';
import * as api from './api';
import type { ConnectParams, EndpointKind, PaneItem, RemoteConnection } from './api';
import * as bfs from './browserFs';
import { ConfirmDialog, PromptDialog, SftpToast } from './Dialogs';
import { FilePane, type PaneState } from './FilePane';
import { TransferPanel, type LogLine, type TransferItem } from './TransferPanel';

const actionBtn =
  'flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-white/55 transition-colors ' +
  'hover:bg-white/[0.06] hover:text-white/85 disabled:cursor-not-allowed disabled:opacity-30';

const BOTTOM_MIN = 84;
const BOTTOM_DEFAULT = 170;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface PaneModel {
  kind: EndpointKind;
  state: PaneState;
  connection: RemoteConnection | null;
  browserStack: FileSystemDirectoryHandle[];
  path: string;
  entries: PaneItem[];
  loading: boolean;
  error: string | null;
  selected: string | null;
}

function initialPane(kind: EndpointKind): PaneModel {
  return {
    kind,
    state: { kind: 'disconnected' },
    connection: null,
    browserStack: [],
    path: '',
    entries: [],
    loading: false,
    error: null,
    selected: null,
  };
}

type DialogState =
  | { pane: 'left' | 'right'; kind: 'newFolder' }
  | { pane: 'left' | 'right'; kind: 'rename'; name: string }
  | { pane: 'left' | 'right'; kind: 'delete'; name: string; isDir: boolean };

export default function SftpPanel() {
  const { t } = useTranslation();
  const [savedConnections, setSavedConnections] = useAtom(sftpSavedConnectionsAtom);

  const [left, setLeft] = useState<PaneModel>(() => initialPane('suwu'));
  const [right, setRight] = useState<PaneModel>(() => initialPane('remote'));

  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: 'info' | 'error' } | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  // Bottom transfer/log panel.
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [logOpen, setLogOpen] = useState(true);
  const [bottomHeight, setBottomHeight] = useState(() => {
    if (typeof window === 'undefined') return BOTTOM_DEFAULT;
    const raw = Number(window.localStorage.getItem('suwu_sftp_bottom_height'));
    return Number.isFinite(raw) && raw >= BOTTOM_MIN ? raw : BOTTOM_DEFAULT;
  });
  const bottomHeightRef = useRef(bottomHeight);
  const transferSeq = useRef(0);
  const logSeq = useRef(0);

  const [leftPct, setLeftPct] = useState(() => {
    if (typeof window === 'undefined') return 50;
    const raw = Number(window.localStorage.getItem('suwu_sftp_left_pct'));
    return Number.isFinite(raw) && raw >= 25 && raw <= 75 ? raw : 50;
  });
  const leftPctRef = useRef(leftPct);
  const splitRef = useRef<HTMLDivElement>(null);

  const notify = useCallback((message: string, tone: 'info' | 'error' = 'info') => {
    setToast({ message, tone });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  const pushLog = useCallback((message: string, tone: LogLine['tone'] = 'info') => {
    const id = ++logSeq.current;
    const time = new Date().toLocaleTimeString([], { hour12: false });
    setLogs((prev) => [...prev.slice(-299), { id, time, message, tone }]);
  }, []);

  const addTransfer = useCallback((name: string, detail: string, total: number) => {
    const id = ++transferSeq.current;
    setTransfers((prev) =>
      [{ id, name, detail, total, loaded: 0, state: 'running' as const }, ...prev].slice(0, 100),
    );
    return id;
  }, []);

  const patchTransfer = useCallback((id: number, patch: Partial<TransferItem>) => {
    setTransfers((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const startLeftResize = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = splitRef.current?.getBoundingClientRect();
    if (!rect) return;
    const onMove = (ev: PointerEvent) => {
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.min(75, Math.max(25, pct));
      leftPctRef.current = clamped;
      setLeftPct(clamped);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.localStorage.setItem('suwu_sftp_left_pct', String(leftPctRef.current));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  const startBottomResize = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = bottomHeightRef.current;
    const onMove = (ev: PointerEvent) => {
      const next = Math.min(
        Math.max(startHeight - (ev.clientY - startY), BOTTOM_MIN),
        window.innerHeight * 0.6,
      );
      bottomHeightRef.current = next;
      setBottomHeight(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.localStorage.setItem('suwu_sftp_bottom_height', String(bottomHeightRef.current));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  const update = useCallback((pane: 'left' | 'right', patch: Partial<PaneModel>) => {
    const setter = pane === 'left' ? setLeft : setRight;
    setter((prev) => ({ ...prev, ...patch }));
  }, []);

  const modelFor = (pane: 'left' | 'right') => (pane === 'left' ? left : right);

  // ── Loading ──────────────────────────────────────────────────────────

  const loadPane = useCallback(
    async (pane: 'left' | 'right', model: PaneModel, path: string) => {
      update(pane, { loading: true, error: null });
      try {
        let entries: PaneItem[];
        let resolved = path;
        if (model.kind === 'browser') {
          const handle = model.browserStack[model.browserStack.length - 1];
          if (!handle) {
            update(pane, { loading: false });
            return;
          }
          entries = await bfs.listBrowserDir(handle);
        } else {
          const endpoint = api.paneEndpoint(model.kind, model.connection?.sessionId);
          const res = await endpoint.list(path);
          entries = res.entries;
          resolved = res.path || path;
        }
        update(pane, { entries, path: resolved, selected: null, loading: false });
      } catch (error) {
        update(pane, { error: describe(error), loading: false });
        pushLog(`List failed: ${describe(error)}`, 'error');
      }
    },
    [update, pushLog],
  );

  useEffect(() => {
    let cancelled = false;
    void api
      .suwuHome()
      .then((home) => {
        if (!cancelled) setLeft((prev) => (prev.path ? prev : { ...prev, path: home }));
      })
      .catch(() => {
        if (!cancelled) setLeft((prev) => (prev.path ? prev : { ...prev, path: '/' }));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const leftKey = `${left.kind}|${left.connection?.sessionId ?? ''}|${left.browserStack.length}|${left.path}`;
  const rightKey = `${right.kind}|${right.connection?.sessionId ?? ''}|${right.browserStack.length}|${right.path}`;

  useEffect(() => {
    if (left.kind === 'remote' && !left.connection) return;
    if (left.kind === 'browser') {
      if (left.browserStack.length === 0) return;
    } else if (!left.path) {
      return;
    }
    void loadPane('left', left, left.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftKey]);

  useEffect(() => {
    if (right.kind === 'remote' && !right.connection) return;
    if (right.kind === 'browser') {
      if (right.browserStack.length === 0) return;
    } else if (!right.path) {
      return;
    }
    void loadPane('right', right, right.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightKey]);

  // ── Kind changes ─────────────────────────────────────────────────────

  const changeKind = useCallback(
    (pane: 'left' | 'right', kind: EndpointKind) => {
      const model = modelFor(pane);
      if (model.kind === kind) return;
      if (model.kind === 'remote' && model.connection) {
        void api.disconnectRemote(model.connection.sessionId);
      }
      update(pane, {
        kind,
        state: kind === 'remote' ? { kind: 'disconnected' } : { kind: 'connected' },
        connection: null,
        browserStack: [],
        entries: [],
        selected: null,
        error: null,
        path: '',
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [left, right, update],
  );

  useEffect(() => {
    for (const [pane, model] of [
      ['left', left],
      ['right', right],
    ] as const) {
      if (model.kind === 'suwu' && !model.path) {
        void api
          .suwuHome()
          .then((home) => update(pane, { path: home }))
          .catch(() => update(pane, { path: '/' }));
      }
    }
  }, [left, right, update]);

  // ── Connect / disconnect ─────────────────────────────────────────────

  const connect = useCallback(
    async (pane: 'left' | 'right', params: ConnectParams) => {
      update(pane, { state: { kind: 'connecting', error: null } });
      try {
        const conn = await api.connectRemote(params);
        update(pane, {
          connection: conn,
          state: { kind: 'connected' },
          path: conn.home,
          selected: null,
        });
        pushLog(`Connected to ${params.user}@${params.host}`, 'success');
        const saved: SavedSftpConnection = {
          id: `${params.user}@${params.host}:${params.port ?? 22}`,
          label: `${params.user}@${params.host}`,
          host: params.host,
          port: params.port,
          user: params.user,
          auth: params.auth,
        };
        setSavedConnections((list) => upsertSavedConnection(list, saved));
      } catch (error) {
        update(pane, { state: { kind: 'connecting', error: describe(error) } });
        pushLog(`Connect failed: ${describe(error)}`, 'error');
      }
    },
    [setSavedConnections, update, pushLog],
  );

  const disconnect = useCallback(
    async (pane: 'left' | 'right') => {
      const model = modelFor(pane);
      if (model.connection) {
        await api.disconnectRemote(model.connection.sessionId);
        pushLog(`Disconnected from ${model.connection.user}@${model.connection.host}`, 'info');
      }
      update(pane, {
        connection: null,
        state: { kind: 'disconnected' },
        entries: [],
        path: '',
        selected: null,
        error: null,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [left, right, update, pushLog],
  );

  const forgetConnection = useCallback(
    (id: string) => setSavedConnections((list) => list.filter((c) => c.id !== id)),
    [setSavedConnections],
  );

  const pickBrowserFolder = useCallback(
    async (pane: 'left' | 'right') => {
      try {
        const handle = await bfs.pickDirectory();
        update(pane, { browserStack: [handle], entries: [], selected: null });
      } catch {
        // The user cancelled the picker.
      }
    },
    [update],
  );

  // ── Navigation ───────────────────────────────────────────────────────

  const openItem = useCallback(
    async (pane: 'left' | 'right', item: PaneItem) => {
      if (!item.isDir) return;
      const model = modelFor(pane);
      if (model.kind === 'browser') {
        const handle = model.browserStack[model.browserStack.length - 1];
        if (!handle) return;
        try {
          const sub = await bfs.getBrowserDir(handle, item.name);
          update(pane, { browserStack: [...model.browserStack, sub], entries: [], selected: null });
        } catch (error) {
          notify(describe(error), 'error');
        }
        return;
      }
      update(pane, { path: api.joinPath(model.path, item.name) });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [left, right, update, notify],
  );

  const upPane = useCallback(
    (pane: 'left' | 'right') => {
      const model = modelFor(pane);
      if (model.kind === 'browser') {
        if (model.browserStack.length > 1) {
          update(pane, {
            browserStack: model.browserStack.slice(0, -1),
            entries: [],
            selected: null,
          });
        }
        return;
      }
      if (model.path && model.path !== '/') update(pane, { path: api.parentPath(model.path) });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [left, right, update],
  );

  // ── Operations ───────────────────────────────────────────────────────

  const run = useCallback(
    async (fn: () => Promise<void>, after?: () => void) => {
      setBusy(true);
      try {
        await fn();
        after?.();
      } catch (error) {
        notify(describe(error), 'error');
        pushLog(describe(error), 'error');
      } finally {
        setBusy(false);
      }
    },
    [notify, pushLog],
  );

  const endpointFor = (model: PaneModel) =>
    api.paneEndpoint(model.kind, model.connection?.sessionId);

  const confirmNewFolder = (name: string) => {
    if (!dialog || dialog.kind !== 'newFolder') return;
    const pane = dialog.pane;
    const model = modelFor(pane);
    void run(
      async () => {
        if (model.kind === 'browser') {
          const handle = model.browserStack[model.browserStack.length - 1];
          if (!handle) throw new Error('no folder selected');
          await bfs.makeBrowserDir(handle, name);
        } else {
          await endpointFor(model).mkdir(api.joinPath(model.path, name));
        }
      },
      () => {
        void loadPane(pane, model, model.path);
        pushLog(`Created folder ${name}`, 'success');
      },
    );
  };

  const confirmRename = (newName: string) => {
    if (!dialog || dialog.kind !== 'rename') return;
    const pane = dialog.pane;
    const model = modelFor(pane);
    void run(
      async () => {
        if (model.kind === 'browser')
          throw new Error('rename is not supported in a browser folder');
        await endpointFor(model).rename(api.joinPath(model.path, dialog.name), newName);
      },
      () => {
        void loadPane(pane, model, model.path);
        pushLog(`Renamed ${dialog.name} to ${newName}`, 'success');
      },
    );
  };

  const confirmDelete = () => {
    if (!dialog || dialog.kind !== 'delete') return;
    const pane = dialog.pane;
    const model = modelFor(pane);
    void run(
      async () => {
        if (model.kind === 'browser') {
          const handle = model.browserStack[model.browserStack.length - 1];
          if (!handle) throw new Error('no folder selected');
          await bfs.removeBrowserEntry(handle, dialog.name, dialog.isDir);
        } else {
          await endpointFor(model).remove(api.joinPath(model.path, dialog.name));
        }
      },
      () => {
        void loadPane(pane, model, model.path);
        pushLog(`Deleted ${dialog.name}`, 'success');
      },
    );
  };

  // ── Transfers ────────────────────────────────────────────────────────

  const paneLabel = (model: PaneModel) =>
    model.kind === 'remote'
      ? model.connection
        ? `${model.connection.user}@${model.connection.host}`
        : 'SFTP'
      : model.kind === 'browser'
        ? t('sftp.modeBrowser')
        : t('sftp.modeSuwu');

  const transfer = useCallback(
    async (from: 'left' | 'right') => {
      const src = modelFor(from);
      const dstPane = from === 'left' ? 'right' : 'left';
      const dst = modelFor(dstPane);
      const item = src.entries.find((e) => e.name === src.selected);
      if (!item) return;

      const srcPath = api.joinPath(src.path, item.name);
      const direction = `${paneLabel(src)} → ${paneLabel(dst)}`;
      const usesProgress = src.kind === 'browser' || dst.kind === 'browser';
      const transferId = addTransfer(
        item.name,
        direction,
        usesProgress && !item.isDir ? item.size : 0,
      );
      pushLog(`Copying ${item.name} (${direction}) …`);

      setBusy(true);
      try {
        const onProgress = (loaded: number, total: number) => {
          patchTransfer(transferId, { loaded, total: total || 0 });
        };

        if (src.kind === 'browser') {
          const handle = src.browserStack[src.browserStack.length - 1];
          if (!handle) throw new Error('no folder selected');
          if (dst.kind === 'browser')
            throw new Error('browser-to-browser copy is not supported yet');
          await api.copyBrowserToEndpoint(handle, item, endpointFor(dst), dst.path, onProgress);
        } else if (dst.kind === 'browser') {
          const dstHandle = dst.browserStack[dst.browserStack.length - 1];
          if (!dstHandle) throw new Error('no folder selected');
          await api.copyEndpointToBrowser(endpointFor(src), srcPath, item, dstHandle, onProgress);
        } else {
          // Server-side copy: there is no byte stream in this page, so poll
          // the destination file size for single-file progress.
          let poll: number | undefined;
          if (!item.isDir && item.size > 0) {
            patchTransfer(transferId, { total: item.size });
            const destEndpoint = endpointFor(dst);
            poll = window.setInterval(() => {
              void destEndpoint
                .list(dst.path)
                .then(({ entries }) => {
                  const found = entries.find((entry) => entry.name === item.name);
                  if (found) {
                    patchTransfer(transferId, { loaded: Math.min(found.size, item.size) });
                  }
                })
                .catch(() => undefined);
            }, 700);
          }
          try {
            await api.serverTransfer({
              sourceKind: src.kind,
              sourceSession: src.connection?.sessionId,
              sourcePath: srcPath,
              destinationKind: dst.kind,
              destSession: dst.connection?.sessionId,
              destinationPath: dst.path,
              recursive: item.isDir,
            });
          } finally {
            if (poll !== undefined) window.clearInterval(poll);
          }
        }

        patchTransfer(transferId, { state: 'done', loaded: item.size || 1, total: item.size || 1 });
        pushLog(`Copied ${item.name}`, 'success');
        notify(t('sftp.copied', { name: item.name }));
        void loadPane(dstPane, dst, dst.path);
      } catch (error) {
        patchTransfer(transferId, { state: 'error', message: describe(error) });
        pushLog(`Copy failed: ${describe(error)}`, 'error');
        notify(describe(error), 'error');
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [left, right, addTransfer, patchTransfer, pushLog, notify, t, loadPane],
  );

  const uploadDroppedFiles = useCallback(
    (pane: 'left' | 'right', files: File[]) => {
      const model = modelFor(pane);
      if (files.length === 0) return;
      if (model.kind === 'browser' && model.browserStack.length === 0) return;

      const total = files.reduce((sum, file) => sum + file.size, 0);
      const transferId = addTransfer(
        files.length === 1 ? files[0].name : `${files.length} files`,
        `→ ${paneLabel(model)}`,
        total,
      );
      pushLog(`Uploading ${files.length} file(s) …`);
      setBusy(true);
      void (async () => {
        try {
          let loadedBase = 0;
          const onProgress = (loaded: number, fileTotal: number) => {
            patchTransfer(transferId, { loaded: loadedBase + loaded, total: total || fileTotal });
          };
          if (model.kind === 'browser') {
            const handle = model.browserStack[model.browserStack.length - 1];
            if (!handle) throw new Error('no folder selected');
            for (const file of files) {
              await bfs.writeBrowserFile(handle, file.name, file);
              loadedBase += file.size;
              onProgress(0, 0);
            }
          } else {
            const endpoint = endpointFor(model);
            for (const file of files) {
              await endpoint.upload(model.path, file.name, file, onProgress);
              loadedBase += file.size;
              onProgress(0, 0);
            }
          }
          patchTransfer(transferId, { state: 'done', loaded: total || 1, total: total || 1 });
          pushLog(`Uploaded ${files.length} file(s)`, 'success');
          void loadPane(pane, model, model.path);
        } catch (error) {
          patchTransfer(transferId, { state: 'error', message: describe(error) });
          pushLog(`Upload failed: ${describe(error)}`, 'error');
          notify(describe(error), 'error');
        } finally {
          setBusy(false);
        }
      })();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [left, right, addTransfer, patchTransfer, pushLog, notify, loadPane],
  );

  const clearPanel = useCallback(() => {
    setLogs([]);
    setTransfers((prev) => prev.filter((item) => item.state === 'running'));
  }, []);

  // ── Pane actions ─────────────────────────────────────────────────────

  const paneActions = (pane: 'left' | 'right') => {
    const model = modelFor(pane);
    const selected = model.entries.find((e) => e.name === model.selected);
    const other = modelFor(pane === 'left' ? 'right' : 'left');
    const canReceive = other.kind !== 'browser' || other.browserStack.length > 0;
    return (
      <>
        <button
          type="button"
          className={actionBtn}
          disabled={busy}
          onClick={() => setDialog({ pane, kind: 'newFolder' })}
        >
          <PlusIcon className="h-3.5 w-3.5" />
          {t('sftp.newFolder')}
        </button>
        <button
          type="button"
          className={actionBtn}
          disabled={busy || !selected || model.kind === 'browser'}
          onClick={() => selected && setDialog({ pane, kind: 'rename', name: selected.name })}
        >
          {t('sftp.rename')}
        </button>
        <button
          type="button"
          className={actionBtn}
          disabled={busy || !selected}
          onClick={() =>
            selected &&
            setDialog({ pane, kind: 'delete', name: selected.name, isDir: selected.isDir })
          }
        >
          <TrashIcon className="h-3.5 w-3.5" />
          {t('sftp.delete')}
        </button>
        <div className="flex-1" />
        <button
          type="button"
          className={actionBtn}
          disabled={busy || !selected || !canReceive}
          onClick={() => void transfer(pane)}
          title={pane === 'left' ? t('sftp.copyRight') : t('sftp.copyLeft')}
        >
          <SwapIcon className="h-3.5 w-3.5" />
          {pane === 'left' ? t('sftp.copyRight') : t('sftp.copyLeft')}
        </button>
      </>
    );
  };

  const renderPane = (pane: 'left' | 'right') => {
    const model = modelFor(pane);
    const browserPath =
      model.kind === 'browser'
        ? `/${model.browserStack
            .map((h) => h.name)
            .slice(1)
            .join('/')}`
        : model.path;
    return (
      <FilePane
        kind={model.kind}
        state={model.state}
        path={browserPath}
        entries={model.entries}
        loading={model.loading}
        error={model.error}
        selected={model.selected}
        canUp={model.kind === 'browser' ? model.browserStack.length > 1 : model.path !== '/'}
        actions={paneActions(pane)}
        savedConnections={savedConnections}
        connecting={model.state.kind === 'connecting'}
        onKindChange={(kind) => changeKind(pane, kind)}
        onConnect={(params) => void connect(pane, params)}
        onDisconnect={() => void disconnect(pane)}
        onForgetConnection={forgetConnection}
        onPickBrowserFolder={() => void pickBrowserFolder(pane)}
        needsBrowserFolder={model.kind === 'browser' && model.browserStack.length === 0}
        onSelect={(name) => update(pane, { selected: name })}
        onOpen={(item) => void openItem(pane, item)}
        onUp={() => upPane(pane)}
        onRefresh={() => void loadPane(pane, model, model.path)}
        onDropFiles={(files) => uploadDroppedFiles(pane, files)}
      />
    );
  };

  return (
    <CommonTileContainer zoomAtom={sftpZoomAtom} noPadding background={DENSE_TILE_BG}>
      <div className="flex h-full flex-col">
        {/* Global header — title only, no action buttons */}
        <div className="flex h-9 shrink-0 items-center border-b border-white/[0.06] px-3">
          <span className="text-sm font-semibold tracking-tight text-white/70">
            {t('sftp.title')}
          </span>
        </div>

        <div ref={splitRef} className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-col" style={{ width: `${leftPct}%` }}>
            {renderPane('left')}
          </div>

          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={startLeftResize}
            className="w-1 shrink-0 cursor-col-resize bg-white/[0.06] transition-colors hover:bg-sky-400/40"
          />

          <div className="flex min-w-0 flex-1 flex-col">{renderPane('right')}</div>
        </div>

        <TransferPanel
          transfers={transfers}
          logs={logs}
          height={logOpen ? bottomHeight : 32}
          collapsed={!logOpen}
          onToggle={() => setLogOpen((open) => !open)}
          onResizeStart={startBottomResize}
          onClear={clearPanel}
        />
      </div>

      {dialog?.kind === 'newFolder' && (
        <PromptDialog
          title={t('sftp.newFolder')}
          label={t('sftp.name')}
          confirmLabel={t('sftp.create')}
          onConfirm={confirmNewFolder}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'rename' && (
        <PromptDialog
          title={t('sftp.rename')}
          label={t('sftp.newName')}
          defaultValue={dialog.name}
          confirmLabel={t('sftp.rename')}
          onConfirm={confirmRename}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={t('sftp.delete')}
          message={t('sftp.deleteConfirm', { name: dialog.name })}
          confirmLabel={t('sftp.delete')}
          danger
          onConfirm={confirmDelete}
          onCancel={() => setDialog(null)}
        />
      )}

      {toast && <SftpToast message={toast.message} tone={toast.tone} />}
    </CommonTileContainer>
  );
}
