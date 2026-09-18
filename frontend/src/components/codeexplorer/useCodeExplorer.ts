import { useCallback, useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import { useAtomValue } from 'jotai';
import i18n from '../../i18n';
import { authFetch } from '../../lib/api';
import { useReportTileState } from '../CommonTileContainer';
import { MONACO_THEME, ensureMonacoTheme } from './monacoSetup';
import { languageForPath } from './languages';
import { completeSave } from './saveState';
import { codeEditorFontOptions, codeEditorSettingsAtom } from '../../store/codeExplorer';
import {
  extensionForPath,
  normalizeCodePath,
  type SearchLocation,
  type SearchSelection,
} from './search';
import { looksBinary, normalizeRanges, type HighlightRange } from './spec';
import type { CodeFileSpec } from '../../store/notifications';
import type { CodeExplorerSessionState } from '../../wm/sessionState';

/** Files larger than this are opened read-only. */
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

export interface CodeTab {
  id: string;
  path: string;
  language: string;
  model: monaco.editor.ITextModel;
  savedVersionId: number;
  mtimeMs: number | null;
  isNew: boolean;
  readOnly: boolean;
  ranges: HighlightRange[];
  error?: string;
}

function newTabId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export interface CodeExplorer {
  containerRef: React.RefObject<HTMLDivElement | null>;
  tabs: CodeTab[];
  activeId: string | null;
  dirty: Record<string, boolean>;
  saving: boolean;
  savedAt: number;
  errors: Record<string, string | undefined>;
  cursor: { line: number; column: number };
  openSignal: number;
  searchSelection: SearchSelection | null;
  openLocation: (path: string, location: SearchLocation) => Promise<void>;
  focusEditor: () => void;
  requestOpen: () => void;
  setActive: (id: string) => void;
  closeTab: (id: string) => void;
  save: (id?: string) => void;
  reload: (id?: string) => void;
  openPath: (path: string, ranges?: HighlightRange[]) => Promise<void>;
  openNewFile: (path: string) => void;
}

/**
 * Owns the Monaco editor, the open tabs, dirty tracking and saving for the
 * Code Explorer tile. Editor models are mutable and live in refs; `tabs`
 * mirrors the metadata React needs to render.
 */
export function useCodeExplorer(
  initialSpecs: CodeFileSpec[],
  restoreSpecs: CodeFileSpec[],
): CodeExplorer {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [editorReady, setEditorReady] = useState(false);

  const [tabs, setTabs] = useState<CodeTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  const [openSignal, setOpenSignal] = useState(0);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [searchSelection, setSearchSelection] = useState<SearchSelection | null>(null);
  const [navigation, setNavigation] = useState<{
    path: string;
    location: SearchLocation;
    id: number;
  } | null>(null);
  const navigationId = useRef(0);
  const mounted = useRef(true);

  const tabsRef = useRef<CodeTab[]>([]);
  tabsRef.current = tabs;
  const editorOptions = useAtomValue(codeEditorSettingsAtom);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const decorationIds = useRef(new Map<string, string[]>());
  const revealed = useRef(new Set<string>());
  const pendingPaths = useRef(new Map<string, Promise<void>>());
  const savingTabs = useRef(new Set<string>());

  const report = useReportTileState();

  const applyDecorations = useCallback((tab: CodeTab) => {
    const ranges = normalizeRanges(tab.ranges, tab.model.getLineCount());
    const previous = decorationIds.current.get(tab.id) ?? [];
    const ids = tab.model.deltaDecorations(
      previous,
      ranges.map((range) => ({
        range: new monaco.Range(range.start, 1, range.end, 1),
        options: { isWholeLine: true, linesDecorationsClassName: 'code-gutter-mark' },
      })),
    );
    decorationIds.current.set(tab.id, ids);
  }, []);

  const activate = useCallback((id: string | null) => {
    const editor = editorRef.current;
    const previous = activeRef.current;
    if (editor && previous && previous !== id) {
      viewStates.current.set(previous, editor.saveViewState());
    }
    activeRef.current = id;
    setActiveId(id);
  }, []);

  const attachModel = useCallback((tab: CodeTab) => {
    tab.model.onDidChangeContent(() => {
      const isDirty = tab.model.getAlternativeVersionId() !== tab.savedVersionId;
      setDirty((prev) => (prev[tab.id] === isDirty ? prev : { ...prev, [tab.id]: isDirty }));
    });
  }, []);

  const openPath = useCallback(
    async (rawPath: string, ranges?: HighlightRange[], activateOnLoad = true) => {
      rawPath = normalizeCodePath(rawPath);
      const existing = tabsRef.current.find((tab) => tab.path === rawPath);
      if (existing) {
        if (activateOnLoad) activate(existing.id);
        return;
      }
      const pending = pendingPaths.current.get(rawPath);
      if (pending) return pending;

      const loading = (async () => {
        try {
          const id = newTabId();
          const language = languageForPath(rawPath);
          let content = '';
          let readOnly = false;
          let mtimeMs: number | null = null;
          let error: string | undefined;

          try {
            const res = await authFetch(`/api/file?path=${encodeURIComponent(rawPath)}`, {
              cache: 'no-store',
            });
            if (!res.ok) {
              const body = (await res.json().catch(() => null)) as { error?: string } | null;
              throw new Error(body?.error || `HTTP ${res.status}`);
            }
            const mtimeHeader = res.headers.get('X-Suwu-Mtime-Ms');
            if (mtimeHeader) mtimeMs = Number(mtimeHeader);
            const bytes = new Uint8Array(await res.arrayBuffer());
            if (bytes.byteLength > MAX_EDIT_BYTES) {
              readOnly = true;
              error = i18n.t('codeExplorer.tooLarge');
            } else if (looksBinary(bytes)) {
              readOnly = true;
              error = i18n.t('codeExplorer.binary');
            } else {
              content = new TextDecoder().decode(bytes);
            }
          } catch (e) {
            error = e instanceof Error ? e.message : i18n.t('codeExplorer.loadFailed');
            readOnly = true;
          }

          if (!mounted.current) return;
          const model = monaco.editor.createModel(content, language, monaco.Uri.file(rawPath));
          const tab: CodeTab = {
            id,
            path: rawPath,
            language,
            model,
            savedVersionId: model.getAlternativeVersionId(),
            mtimeMs,
            isNew: false,
            readOnly,
            ranges: normalizeRanges(ranges, model.getLineCount()),
            error,
          };
          attachModel(tab);
          applyDecorations(tab);
          tabsRef.current = [...tabsRef.current, tab];
          setTabs(tabsRef.current);
          if (error) setErrors((prev) => ({ ...prev, [id]: error }));
          if (activateOnLoad) activate(id);
        } finally {
          pendingPaths.current.delete(rawPath);
        }
      })();
      pendingPaths.current.set(rawPath, loading);
      return loading;
    },
    [activate, attachModel, applyDecorations],
  );

  const openLocation = useCallback(
    async (rawPath: string, location: SearchLocation) => {
      const path = normalizeCodePath(rawPath);
      const id = ++navigationId.current;
      await openPath(path, undefined, false);
      if (!mounted.current || id !== navigationId.current) return;
      const tab = tabsRef.current.find((candidate) => candidate.path === path);
      if (!tab || tab.error) throw new Error(tab?.error ?? i18n.t('codeExplorer.loadFailed'));
      activate(tab.id);
      setNavigation({ path, location, id });
    },
    [activate, openPath],
  );

  const openNewFile = useCallback(
    (path: string) => {
      path = normalizeCodePath(path);
      const existing = tabsRef.current.find((tab) => tab.path === path);
      if (existing) {
        activate(existing.id);
        return;
      }
      const id = newTabId();
      const language = languageForPath(path);
      const model = monaco.editor.createModel('', language, monaco.Uri.file(path));
      const tab: CodeTab = {
        id,
        path,
        language,
        model,
        savedVersionId: -1,
        mtimeMs: null,
        isNew: true,
        readOnly: false,
        ranges: [],
      };
      attachModel(tab);
      tabsRef.current = [...tabsRef.current, tab];
      setTabs(tabsRef.current);
      setDirty((prev) => ({ ...prev, [id]: true }));
      activate(id);
    },
    [activate, attachModel],
  );

  const save = useCallback(async (id?: string) => {
    const tabId = id ?? activeRef.current;
    if (!tabId) return;
    const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
    if (!tab || tab.readOnly || savingTabs.current.has(tabId)) return;

    const submittedVersionId = tab.model.getAlternativeVersionId();
    const payload: Record<string, unknown> = { path: tab.path, content: tab.model.getValue() };
    if (!tab.isNew && tab.mtimeMs !== null) payload.mtimeMs = tab.mtimeMs;

    savingTabs.current.add(tabId);
    setSaving(true);
    try {
      const res = await authFetch('/api/file/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        mtimeMs?: number;
        path?: string;
      } | null;
      if (tab.model.isDisposed()) return;
      if (!res.ok) {
        setErrors((prev) => ({ ...prev, [tabId]: body?.error ?? `HTTP ${res.status}` }));
        return;
      }
      const isDirty = completeSave(tab, submittedVersionId, body?.mtimeMs);
      if (isDirty === null) return;
      setErrors((prev) => ({ ...prev, [tabId]: undefined }));
      setDirty((prev) => ({ ...prev, [tabId]: isDirty }));
      setSavedAt(Date.now());
      setTabs([...tabsRef.current]);
    } catch (e) {
      if (!tab.model.isDisposed()) {
        setErrors((prev) => ({
          ...prev,
          [tabId]: e instanceof Error ? e.message : i18n.t('codeExplorer.saveFailed'),
        }));
      }
    } finally {
      savingTabs.current.delete(tabId);
      setSaving(savingTabs.current.size > 0);
    }
  }, []);

  const reload = useCallback(async (id?: string) => {
    const tabId = id ?? activeRef.current;
    if (!tabId) return;
    const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
    if (!tab || tab.isNew) return;
    try {
      const res = await authFetch(`/api/file?path=${encodeURIComponent(tab.path)}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      const mtimeHeader = res.headers.get('X-Suwu-Mtime-Ms');
      if (mtimeHeader) tab.mtimeMs = Number(mtimeHeader);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (looksBinary(bytes)) {
        setErrors((prev) => ({ ...prev, [tabId]: i18n.t('codeExplorer.binary') }));
        return;
      }
      tab.model.setValue(new TextDecoder().decode(bytes));
      tab.savedVersionId = tab.model.getAlternativeVersionId();
      tab.error = undefined;
      setErrors((prev) => ({ ...prev, [tabId]: undefined }));
      setDirty((prev) => ({ ...prev, [tabId]: false }));
    } catch (e) {
      setErrors((prev) => ({
        ...prev,
        [tabId]: e instanceof Error ? e.message : i18n.t('codeExplorer.loadFailed'),
      }));
    }
  }, []);

  const closeTab = useCallback(
    (id: string) => {
      const tab = tabsRef.current.find((candidate) => candidate.id === id);
      if (!tab) return;
      if (tab.model.getAlternativeVersionId() !== tab.savedVersionId) {
        const name = tab.path.split('/').pop() ?? tab.path;
        if (!window.confirm(i18n.t('codeExplorer.discardChanges', { name }))) return;
      }
      const editor = editorRef.current;
      viewStates.current.delete(id);
      decorationIds.current.delete(id);
      revealed.current.delete(id);
      if (editor && editor.getModel() === tab.model) editor.setModel(null);
      tab.model.dispose();
      const next = tabsRef.current.filter((candidate) => candidate.id !== id);
      tabsRef.current = next;
      setTabs(next);
      setDirty((prev) => {
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });
      setErrors((prev) => {
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });
      if (activeRef.current === id) {
        activate(next[next.length - 1]?.id ?? null);
      }
    },
    [activate],
  );

  const requestOpen = useCallback(() => setOpenSignal((value) => value + 1), []);
  const saveRef = useRef(save);
  saveRef.current = save;

  // Create the editor once.
  useEffect(() => {
    if (!containerRef.current || editorRef.current) return;
    mounted.current = true;
    ensureMonacoTheme();
    const editor = monaco.editor.create(containerRef.current, {
      theme: MONACO_THEME,
      model: null,
      automaticLayout: true,
      ...codeEditorFontOptions(editorOptions),
      fontLigatures: true,
      minimap: { enabled: false },
      glyphMargin: false,
      folding: true,
      lineDecorationsWidth: 12,
      lineNumbersMinChars: 3,
      renderLineHighlight: 'line',
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      tabSize: 2,
      padding: { top: 8, bottom: 8 },
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      bracketPairColorization: { enabled: false },
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      overviewRulerBorder: false,
      scrollbar: {
        vertical: 'auto',
        horizontal: 'auto',
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
      },
    });
    editorRef.current = editor;
    editor.onDidChangeCursorPosition((event) => {
      setCursor({ line: event.position.lineNumber, column: event.position.column });
    });
    editor.addAction({
      id: 'suwu-code-save',
      label: 'Save',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {
        void saveRef.current();
      },
    });
    for (const custom of [false, true]) {
      editor.addAction({
        id: custom ? 'suwu-find-custom-directory' : 'suwu-find-file-directory',
        label: i18n.t(
          custom ? 'codeExplorer.search.customDirectory' : 'codeExplorer.search.fileDirectory',
        ),
        precondition: 'editorHasSelection',
        contextMenuGroupId: '9_suwu_search',
        contextMenuOrder: custom ? 2 : 1,
        run: () => {
          const selection = editor.getSelection();
          const model = editor.getModel();
          const tab = tabsRef.current.find((candidate) => candidate.model === model);
          if (!selection || selection.isEmpty() || !model || !tab) return;
          const query = model.getValueInRange(selection);
          setSearchSelection((previous) => ({
            id: (previous?.id ?? 0) + 1,
            query,
            directory: tab.path.slice(0, tab.path.lastIndexOf('/')) || '/',
            custom,
            extension: extensionForPath(tab.path),
          }));
        },
      });
    }
    setEditorReady(true);
    return () => {
      mounted.current = false;
      editor.dispose();
      editorRef.current = null;
      for (const tab of tabsRef.current) tab.model.dispose();
      tabsRef.current = [];
    };
  }, []);

  // Apply editor font settings without recreating the editor.
  useEffect(() => {
    editorRef.current?.updateOptions(codeEditorFontOptions(editorOptions));
  }, [editorOptions]);

  // Open the files handed over by the action resolver (`suwu code`).
  const initialOpened = useRef(false);
  useEffect(() => {
    if (!editorReady || initialOpened.current) return;
    initialOpened.current = true;
    void (async () => {
      for (const spec of initialSpecs) {
        await openPath(spec.path, spec.ranges);
      }
    })();
  }, [editorReady, initialSpecs, openPath]);

  // Restore saved (on-disk) tabs from the previous session.
  const restored = useRef(false);
  useEffect(() => {
    if (!editorReady || restored.current || restoreSpecs.length === 0) return;
    restored.current = true;
    void (async () => {
      for (const spec of restoreSpecs) {
        if (!tabsRef.current.some((tab) => tab.path === spec.path)) {
          await openPath(spec.path, spec.ranges);
        }
      }
    })();
  }, [editorReady, restoreSpecs, openPath]);

  // Apply the active model, its gutter marks, and scroll to the first range.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !activeId) return;
    const tab = tabs.find((candidate) => candidate.id === activeId);
    if (!tab) return;
    if (editor.getModel() !== tab.model) {
      editor.setModel(tab.model);
      const state = viewStates.current.get(activeId);
      if (state) editor.restoreViewState(state);
    }
    if (!revealed.current.has(tab.id) && tab.ranges.length > 0) {
      revealed.current.add(tab.id);
      editor.revealLineInCenter(tab.ranges[0].start);
      editor.setPosition({ lineNumber: tab.ranges[0].start, column: 1 });
    }
    editor.focus();
  }, [activeId, tabs]);

  // Run after model attachment/view restoration, including same-tab jumps.
  useEffect(() => {
    if (!navigation) return;
    const editor = editorRef.current;
    const tab = tabs.find((candidate) => candidate.path === navigation.path);
    if (!editor || !tab || activeId !== tab.id || editor.getModel() !== tab.model) return;
    const { line, column, endLine, endColumn } = navigation.location;
    const range = tab.model.validateRange(new monaco.Range(line, column, endLine, endColumn));
    editor.setSelection(range);
    editor.revealRangeInCenter(range);
    editor.focus();
    setNavigation(null);
  }, [navigation, activeId, tabs]);

  // Persist the restorable session state (saved files only).
  useEffect(() => {
    const state: CodeExplorerSessionState = {
      tabs: tabs
        .filter((tab) => !tab.isNew)
        .map((tab) => ({ path: tab.path, ranges: tab.ranges.length > 0 ? tab.ranges : undefined })),
      activePath: tabs.find((tab) => tab.id === activeId && !tab.isNew)?.path,
    };
    report(state as unknown as Record<string, unknown>);
  }, [tabs, activeId, report]);

  // Warn before leaving with unsaved changes.
  const anyDirty = Object.values(dirty).some(Boolean);
  useEffect(() => {
    if (!anyDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [anyDirty]);

  // Toolbar IPC.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const data = e.data as { type?: string } | undefined;
      if (data?.type === 'code-save') void saveRef.current();
      else if (data?.type === 'code-open') setOpenSignal((value) => value + 1);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  return {
    containerRef,
    tabs,
    activeId,
    dirty,
    saving,
    savedAt,
    errors,
    cursor,
    openSignal,
    requestOpen,
    searchSelection,
    openLocation,
    focusEditor: () => {
      navigationId.current++;
      editorRef.current?.focus();
    },
    setActive: activate,
    closeTab,
    save: (id?: string) => void save(id),
    reload: (id?: string) => void reload(id),
    openPath,
    openNewFile,
  };
}
