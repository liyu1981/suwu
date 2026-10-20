import {
  type MouseEvent as ReactMouseEvent,
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
import { formatSize } from '../../lib/format';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { formatModTime, sameModTime } from './format';
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
/** How many times an expired session is re-dialled before giving up. */
const RECONNECT_ATTEMPTS = 3;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The server reports a closed/cleaned-up session with this message. */
function isExpiredSession(error: unknown): boolean {
  return /session not found or expired/i.test(describe(error));
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

type PaneSide = 'left' | 'right';

type ConflictPrompt =
  | {
      kind: 'single';
      name: string;
      incomingSize: number;
      incomingTime: string;
      existingSize: number;
      existingTime: string;
      resolve: (overwrite: boolean) => void;
    }
  | { kind: 'many'; count: number; resolve: (overwrite: boolean) => void };

export default function SftpPanel() {
  const { t } = useTranslation();
  const [savedConnections, setSavedConnections] = useAtom(sftpSavedConnectionsAtom);

  const [left, setLeft] = useState<PaneModel>(() => initialPane('suwu'));
  const [right, setRight] = useState<PaneModel>(() => initialPane('remote'));

  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [conflict, setConflict] = useState<ConflictPrompt | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[][];
  } | null>(null);
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

  // Latest pane data for async flows (state setters alone are stale in callbacks).
  const modelsRef = useRef<{ left: PaneModel; right: PaneModel }>({ left, right });
  useEffect(() => {
    modelsRef.current = { left, right };
  }, [left, right]);

  // Credentials are kept in memory (never persisted) so an expired session can
  // be re-dialled silently. Cleared on disconnect / endpoint change.
  const credsRef = useRef<{ left: ConnectParams | null; right: ConnectParams | null }>({
    left: null,
    right: null,
  });
  const connRef = useRef<{ left: RemoteConnection | null; right: RemoteConnection | null }>({
    left: null,
    right: null,
  });

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

  const update = useCallback((pane: PaneSide, patch: Partial<PaneModel>) => {
    const setter = pane === 'left' ? setLeft : setRight;
    setter((prev) => ({ ...prev, ...patch }));
  }, []);

  const modelFor = (pane: PaneSide) => (pane === 'left' ? left : right);
  const live = (pane: PaneSide) => modelsRef.current[pane];

  const sessionOf = (pane: PaneSide) =>
    connRef.current[pane]?.sessionId ?? modelsRef.current[pane].connection?.sessionId;

  /** Endpoint for a pane, reading the live connection (so reconnect is picked up). */
  const endpointFor = useCallback((pane: PaneSide): api.PaneEndpoint => {
    const model = modelsRef.current[pane];
    if (model.kind === 'remote') {
      const conn = connRef.current[pane] ?? model.connection;
      if (!conn) throw new Error('session not found or expired');
      return api.paneEndpoint('remote', conn.sessionId);
    }
    return api.paneEndpoint(model.kind);
  }, []);

  /** Re-dial a remote pane with its retained credentials. */
  const reconnect = useCallback(
    async (pane: PaneSide): Promise<RemoteConnection | null> => {
      const creds = credsRef.current[pane];
      if (!creds) return null;
      for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt++) {
        try {
          const conn = await api.connectRemote(creds);
          connRef.current[pane] = conn;
          update(pane, {
            connection: conn,
            state: { kind: 'connected' },
            path: live(pane).path || conn.home,
            error: null,
          });
          pushLog(`Reconnected to ${conn.user}@${conn.host}`, 'success');
          return conn;
        } catch (error) {
          if (attempt === RECONNECT_ATTEMPTS) {
            connRef.current[pane] = null;
            update(pane, {
              connection: null,
              state: { kind: 'connecting', error: describe(error) },
              entries: [],
              selected: null,
              path: '',
            });
            pushLog(`Reconnect failed: ${describe(error)}`, 'error');
            return null;
          }
          await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
        }
      }
      return null;
    },
    [update, pushLog],
  );

  /** Run an operation, reconnecting and retrying once if the session expired. */
  const withExpiryRetry = useCallback(
    async <T,>(pane: PaneSide, fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        const model = live(pane);
        if (model.kind === 'remote' && credsRef.current[pane] && isExpiredSession(error)) {
          const conn = await reconnect(pane);
          if (conn) return await fn();
        }
        throw error;
      }
    },
    [reconnect],
  );

  /** List the destination pane's current directory (for collision checks). */
  const listDestination = useCallback(
    async (pane: PaneSide): Promise<PaneItem[]> => {
      const model = live(pane);
      if (model.kind === 'browser') {
        const handle = model.browserStack[model.browserStack.length - 1];
        return handle ? bfs.listBrowserDir(handle) : [];
      }
      const { entries } = await withExpiryRetry(pane, () => endpointFor(pane).list(model.path));
      return entries;
    },
    [endpointFor, withExpiryRetry],
  );

  const askOverwrite = useCallback(
    (info: Omit<Extract<ConflictPrompt, { kind: 'single' }>, 'kind' | 'resolve'>) =>
      new Promise<boolean>((resolve) => setConflict({ kind: 'single', ...info, resolve })),
    [],
  );

  const askOverwriteMany = useCallback(
    (count: number) =>
      new Promise<boolean>((resolve) => setConflict({ kind: 'many', count, resolve })),
    [],
  );

  // ── Loading ──────────────────────────────────────────────────────────

  const loadPane = useCallback(
    async (pane: PaneSide, path: string) => {
      const model = live(pane);
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
          const res = await withExpiryRetry(pane, () => endpointFor(pane).list(path));
          entries = res.entries;
          resolved = res.path || path;
        }
        update(pane, { entries, path: resolved, selected: null, loading: false });
      } catch (error) {
        update(pane, { error: describe(error), loading: false });
        pushLog(`List failed: ${describe(error)}`, 'error');
      }
    },
    [update, pushLog, withExpiryRetry, endpointFor],
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
    void loadPane('left', left.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftKey]);

  useEffect(() => {
    if (right.kind === 'remote' && !right.connection) return;
    if (right.kind === 'browser') {
      if (right.browserStack.length === 0) return;
    } else if (!right.path) {
      return;
    }
    void loadPane('right', right.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rightKey]);

  // ── Kind changes ─────────────────────────────────────────────────────

  const changeKind = useCallback(
    (pane: PaneSide, kind: EndpointKind) => {
      const model = live(pane);
      if (model.kind === kind) return;
      if (model.kind === 'remote' && model.connection) {
        void api.disconnectRemote(model.connection.sessionId);
      }
      credsRef.current[pane] = null;
      connRef.current[pane] = null;
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
    [update],
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
    async (pane: PaneSide, params: ConnectParams) => {
      update(pane, { state: { kind: 'connecting', error: null } });
      try {
        const conn = await api.connectRemote(params);
        credsRef.current[pane] = params;
        connRef.current[pane] = conn;
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
    async (pane: PaneSide) => {
      const model = live(pane);
      if (model.connection) {
        await api.disconnectRemote(model.connection.sessionId);
        pushLog(`Disconnected from ${model.connection.user}@${model.connection.host}`, 'info');
      }
      credsRef.current[pane] = null;
      connRef.current[pane] = null;
      update(pane, {
        connection: null,
        state: { kind: 'disconnected' },
        entries: [],
        path: '',
        selected: null,
        error: null,
      });
    },
    [update, pushLog],
  );

  const forgetConnection = useCallback(
    (id: string) => setSavedConnections((list) => list.filter((c) => c.id !== id)),
    [setSavedConnections],
  );

  const pickBrowserFolder = useCallback(
    async (pane: PaneSide) => {
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
    async (pane: PaneSide, item: PaneItem) => {
      if (!item.isDir) return;
      const model = live(pane);
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
    [update, notify],
  );

  const upPane = useCallback(
    (pane: PaneSide) => {
      const model = live(pane);
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
    [update],
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

  const confirmNewFolder = (name: string) => {
    if (!dialog || dialog.kind !== 'newFolder') return;
    const pane = dialog.pane;
    void run(
      async () => {
        const model = live(pane);
        if (model.kind === 'browser') {
          const handle = model.browserStack[model.browserStack.length - 1];
          if (!handle) throw new Error('no folder selected');
          await bfs.makeBrowserDir(handle, name);
        } else {
          await withExpiryRetry(pane, () =>
            endpointFor(pane).mkdir(api.joinPath(model.path, name)),
          );
        }
      },
      () => {
        void loadPane(pane, live(pane).path);
        pushLog(`Created folder ${name}`, 'success');
      },
    );
  };

  const confirmRename = (newName: string) => {
    if (!dialog || dialog.kind !== 'rename') return;
    const pane = dialog.pane;
    void run(
      async () => {
        const model = live(pane);
        if (model.kind === 'browser')
          throw new Error('rename is not supported in a browser folder');
        await withExpiryRetry(pane, () =>
          endpointFor(pane).rename(api.joinPath(model.path, dialog.name), newName),
        );
      },
      () => {
        void loadPane(pane, live(pane).path);
        pushLog(`Renamed ${dialog.name} to ${newName}`, 'success');
      },
    );
  };

  const confirmDelete = () => {
    if (!dialog || dialog.kind !== 'delete') return;
    const pane = dialog.pane;
    void run(
      async () => {
        const model = live(pane);
        if (model.kind === 'browser') {
          const handle = model.browserStack[model.browserStack.length - 1];
          if (!handle) throw new Error('no folder selected');
          await bfs.removeBrowserEntry(handle, dialog.name, dialog.isDir);
        } else {
          await withExpiryRetry(pane, () =>
            endpointFor(pane).remove(api.joinPath(model.path, dialog.name)),
          );
        }
      },
      () => {
        void loadPane(pane, live(pane).path);
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
    async (from: PaneSide) => {
      const dstPane: PaneSide = from === 'left' ? 'right' : 'left';
      const initial = live(from).entries.find((e) => e.name === live(from).selected);
      if (!initial) return;

      // Files: skip identical copies, prompt when an existing file differs.
      let overwrite = false;
      if (!initial.isDir) {
        setBusy(true);
        try {
          const existing = (await listDestination(dstPane)).find((e) => e.name === initial.name);
          if (existing && !existing.isDir) {
            if (existing.size === initial.size && sameModTime(existing.modTime, initial.modTime)) {
              pushLog(`${initial.name} is already up to date`, 'info');
              return;
            }
            const ok = await askOverwrite({
              name: initial.name,
              incomingSize: initial.size,
              incomingTime: initial.modTime,
              existingSize: existing.size,
              existingTime: existing.modTime,
            });
            if (!ok) {
              pushLog(`Skipped ${initial.name}`, 'info');
              return;
            }
            overwrite = true;
          }
        } catch (error) {
          // A broken check should not block the copy; the transfer reports it.
          pushLog(`Could not check ${initial.name}: ${describe(error)}`, 'error');
        } finally {
          setBusy(false);
        }
      }

      const direction = `${paneLabel(live(from))} → ${paneLabel(live(dstPane))}`;
      const usesProgress = live(from).kind === 'browser' || live(dstPane).kind === 'browser';
      const transferId = addTransfer(
        initial.name,
        direction,
        usesProgress && !initial.isDir ? initial.size : 0,
      );
      pushLog(`Copying ${initial.name} (${direction}) …`);

      let poll: number | undefined;

      const execute = async () => {
        const src = live(from);
        const dst = live(dstPane);
        const item = src.entries.find((e) => e.name === initial.name) ?? initial;
        const srcPath = api.joinPath(src.path, item.name);
        const onProgress = (loaded: number, total: number) => {
          patchTransfer(transferId, { loaded, total: total || 0 });
        };

        if (src.kind === 'browser') {
          const handle = src.browserStack[src.browserStack.length - 1];
          if (!handle) throw new Error('no folder selected');
          if (dst.kind === 'browser')
            throw new Error('browser-to-browser copy is not supported yet');
          await api.copyBrowserToEndpoint(handle, item, endpointFor(dstPane), dst.path, onProgress);
          return;
        }
        if (dst.kind === 'browser') {
          const dstHandle = dst.browserStack[dst.browserStack.length - 1];
          if (!dstHandle) throw new Error('no folder selected');
          await api.copyEndpointToBrowser(endpointFor(from), srcPath, item, dstHandle, onProgress);
          return;
        }

        // Server-side copy: no byte stream here, so poll the destination size.
        if (!item.isDir && item.size > 0) {
          patchTransfer(transferId, { total: item.size });
          const destEndpoint = endpointFor(dstPane);
          poll = window.setInterval(() => {
            void destEndpoint
              .list(dst.path)
              .then(({ entries }) => {
                const found = entries.find((entry) => entry.name === item.name);
                if (found) patchTransfer(transferId, { loaded: Math.min(found.size, item.size) });
              })
              .catch(() => undefined);
          }, 700);
        }
        try {
          await api.serverTransfer({
            sourceKind: src.kind,
            sourceSession: sessionOf(from),
            sourcePath: srcPath,
            destinationKind: dst.kind,
            destSession: sessionOf(dstPane),
            destinationPath: dst.path,
            recursive: item.isDir,
            overwrite,
          });
        } finally {
          if (poll !== undefined) {
            window.clearInterval(poll);
            poll = undefined;
          }
        }
      };

      setBusy(true);
      try {
        try {
          await execute();
        } catch (error) {
          if (!isExpiredSession(error)) throw error;
          // A pane's session expired mid-way: re-dial the remote sides and retry.
          let reconnected = false;
          for (const side of ['left', 'right'] as const) {
            if (live(side).kind === 'remote' && credsRef.current[side]) {
              if (await reconnect(side)) reconnected = true;
            }
          }
          if (!reconnected) throw error;
          await execute();
        }

        patchTransfer(transferId, {
          state: 'done',
          loaded: initial.size || 1,
          total: initial.size || 1,
        });
        pushLog(`Copied ${initial.name}`, 'success');
        notify(t('sftp.copied', { name: initial.name }));
        void loadPane(dstPane, live(dstPane).path);
      } catch (error) {
        patchTransfer(transferId, { state: 'error', message: describe(error) });
        pushLog(`Copy failed: ${describe(error)}`, 'error');
        notify(describe(error), 'error');
      } finally {
        if (poll !== undefined) window.clearInterval(poll);
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [left, right, addTransfer, patchTransfer, pushLog, notify, t, loadPane, endpointFor, reconnect],
  );

  const uploadDroppedFiles = useCallback(
    (pane: PaneSide, files: File[]) => {
      if (files.length === 0) return;
      if (live(pane).kind === 'browser' && live(pane).browserStack.length === 0) return;

      setBusy(true);
      void (async () => {
        try {
          // Collision check: skip identical files, ask once for the rest.
          let accepted = files;
          try {
            const existing = await listDestination(pane);
            const map = new Map(existing.map((entry) => [entry.name, entry] as const));
            const identical: File[] = [];
            const conflicts: File[] = [];
            for (const file of files) {
              const entry = map.get(file.name);
              if (!entry || entry.isDir) continue;
              const same =
                entry.size === file.size &&
                sameModTime(entry.modTime, new Date(file.lastModified).toISOString());
              if (same) identical.push(file);
              else conflicts.push(file);
            }
            for (const file of identical) {
              pushLog(`Skipped ${file.name} (already up to date)`, 'info');
            }
            accepted = files.filter((file) => !identical.includes(file));
            if (conflicts.length > 0) {
              const ok = await askOverwriteMany(conflicts.length);
              if (!ok) accepted = accepted.filter((file) => !conflicts.includes(file));
            }
          } catch (error) {
            pushLog(`Could not check existing files: ${describe(error)}`, 'error');
          }
          if (accepted.length === 0) return;

          const total = accepted.reduce((sum, file) => sum + file.size, 0);
          const transferId = addTransfer(
            accepted.length === 1 ? accepted[0].name : `${accepted.length} files`,
            `→ ${paneLabel(live(pane))}`,
            total,
          );
          pushLog(`Uploading ${accepted.length} file(s) …`);

          const execute = async () => {
            const model = live(pane);
            let loadedBase = 0;
            const onProgress = (loaded: number, fileTotal: number) => {
              patchTransfer(transferId, { loaded: loadedBase + loaded, total: total || fileTotal });
            };
            if (model.kind === 'browser') {
              const handle = model.browserStack[model.browserStack.length - 1];
              if (!handle) throw new Error('no folder selected');
              for (const file of accepted) {
                await bfs.writeBrowserFile(handle, file.name, file);
                loadedBase += file.size;
                onProgress(0, 0);
              }
              return;
            }
            for (const file of accepted) {
              await withExpiryRetry(pane, () =>
                endpointFor(pane).upload(model.path, file.name, file, onProgress),
              );
              loadedBase += file.size;
              onProgress(0, 0);
            }
          };

          try {
            await execute();
            patchTransfer(transferId, { state: 'done', loaded: total || 1, total: total || 1 });
            pushLog(`Uploaded ${accepted.length} file(s)`, 'success');
            void loadPane(pane, live(pane).path);
          } catch (error) {
            patchTransfer(transferId, { state: 'error', message: describe(error) });
            pushLog(`Upload failed: ${describe(error)}`, 'error');
            notify(describe(error), 'error');
          }
        } finally {
          setBusy(false);
        }
      })();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      left,
      right,
      addTransfer,
      patchTransfer,
      pushLog,
      notify,
      loadPane,
      withExpiryRetry,
      endpointFor,
      listDestination,
      askOverwriteMany,
    ],
  );

  const clearPanel = useCallback(() => {
    setLogs([]);
    setTransfers((prev) => prev.filter((item) => item.state === 'running'));
  }, []);

  const showContextMenu = useCallback(
    (pane: PaneSide, event: ReactMouseEvent<HTMLElement>, item: PaneItem | null) => {
      const zoom = Number.parseFloat(document.documentElement.style.zoom) || 1;
      const model = live(pane);
      const other = live(pane === 'left' ? 'right' : 'left');
      const canReceive = other.kind !== 'browser' || other.browserStack.length > 0;
      const canUp = model.kind === 'browser' ? model.browserStack.length > 1 : model.path !== '/';
      const items: ContextMenuItem[][] = [
        [
          {
            label: pane === 'left' ? t('sftp.copyRight') : t('sftp.copyLeft'),
            disabled: busy || !item || !canReceive,
            onClick: () => void transfer(pane),
          },
        ],
        [
          {
            label: t('sftp.rename'),
            disabled: !item || model.kind === 'browser',
            onClick: () => item && setDialog({ pane, kind: 'rename', name: item.name }),
          },
          {
            label: t('sftp.delete'),
            danger: true,
            disabled: !item,
            onClick: () =>
              item && setDialog({ pane, kind: 'delete', name: item.name, isDir: item.isDir }),
          },
        ],
        [
          { label: t('sftp.newFolder'), onClick: () => setDialog({ pane, kind: 'newFolder' }) },
          { label: t('sftp.refresh'), onClick: () => void loadPane(pane, model.path) },
          { label: t('sftp.up'), disabled: !canUp, onClick: () => upPane(pane) },
        ],
      ];
      setMenu({ x: event.clientX / zoom, y: event.clientY / zoom, items });
    },
    [busy, transfer, loadPane, upPane, t],
  );

  // ── Pane actions ─────────────────────────────────────────────────────

  const paneActions = (pane: PaneSide) => {
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

  const renderPane = (pane: PaneSide) => {
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
        onRefresh={() => void loadPane(pane, model.path)}
        onDropFiles={(files) => uploadDroppedFiles(pane, files)}
        onContextMenu={(event, item) => showContextMenu(pane, event, item)}
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

      {menu && (
        <ContextMenu
          items={menu.items}
          position={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
        />
      )}

      {conflict && (
        <ConfirmDialog
          title={t('sftp.overwriteTitle')}
          message={
            conflict.kind === 'single' ? (
              <div className="space-y-1.5">
                <p>{t('sftp.overwriteMessage', { name: conflict.name })}</p>
                <div className="space-y-0.5 text-[11px] text-white/40">
                  <p>
                    {t('sftp.incoming')}: {formatModTime(conflict.incomingTime)} ·{' '}
                    {formatSize(conflict.incomingSize)}
                  </p>
                  <p>
                    {t('sftp.existing')}: {formatModTime(conflict.existingTime)} ·{' '}
                    {formatSize(conflict.existingSize)}
                  </p>
                </div>
              </div>
            ) : (
              t('sftp.overwriteMany', { count: conflict.count })
            )
          }
          confirmLabel={t('sftp.overwrite')}
          danger
          onConfirm={() => {
            conflict.resolve(true);
            setConflict(null);
          }}
          onCancel={() => {
            conflict.resolve(false);
            setConflict(null);
          }}
        />
      )}

      {toast && <SftpToast message={toast.message} tone={toast.tone} />}
    </CommonTileContainer>
  );
}
