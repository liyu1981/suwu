import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

// Use the locally bundled Monaco instead of a CDN.
loader.config({ monaco });

/** Shared Suwu editor theme (transparent so the glass tile shows through). */
export const MONACO_THEME = 'suwu-code';

let themeReady = false;

/** Register the shared editor theme once and apply it. */
export function ensureMonacoTheme(m: typeof monaco = monaco): void {
  if (themeReady) return;
  themeReady = true;
  m.editor.defineTheme(MONACO_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c084fc' },
      { token: 'string', foreground: '86efac' },
      { token: 'number', foreground: 'fbbf24' },
      { token: 'type', foreground: '93c5fd' },
      { token: 'type.identifier', foreground: '93c5fd' },
      { token: 'identifier', foreground: 'e2e8f0' },
      { token: 'delimiter', foreground: '94a3b8' },
    ],
    colors: {
      'editor.background': '#0f0f1100',
      'editor.foreground': '#e2e8f0',
      'editor.lineHighlightBackground': '#ffffff08',
      'editorCursor.foreground': '#0ea5e9',
      'editor.selectionBackground': '#0ea5e930',
      'editor.inactiveSelectionBackground': '#0ea5e915',
      'editorLineNumber.foreground': '#ffffff30',
      'editorLineNumber.activeForeground': '#ffffff60',
      'editorIndentGuide.background1': '#ffffff10',
      'editorIndentGuide.activeBackground1': '#ffffff20',
      'editor.selectionHighlightBackground': '#0ea5e915',
      'editorGutter.background': '#00000000',
      'minimap.background': '#00000000',
      'scrollbarSlider.background': '#ffffff10',
      'scrollbarSlider.hoverBackground': '#ffffff20',
      'scrollbarSlider.activeBackground': '#ffffff30',
    },
  });
  m.editor.setTheme(MONACO_THEME);
}
