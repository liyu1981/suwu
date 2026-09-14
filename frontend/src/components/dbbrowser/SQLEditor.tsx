import { useRef, useCallback } from 'react'
import Editor, { type OnMount, loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'

// Configure Monaco to use the local bundle instead of CDN
loader.config({ monaco })

interface SQLEditorProps {
  value: string
  onChange: (value: string) => void
  onExecute: () => void
  readOnly?: boolean
}

export default function SQLEditor({ value, onChange, onExecute, readOnly }: SQLEditorProps) {
  const editorRef = useRef<unknown>(null)

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor

      // Register custom theme
      monaco.editor.defineTheme('suwu-db', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: 'keyword', foreground: 'c084fc' },
          { token: 'keyword.sql', foreground: 'c084fc' },
          { token: 'string', foreground: '86efac' },
          { token: 'string.sql', foreground: '86efac' },
          { token: 'number', foreground: 'fbbf24' },
          { token: 'number.sql', foreground: 'fbbf24' },
          { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
          { token: 'comment.sql', foreground: '6b7280', fontStyle: 'italic' },
          { token: 'operator.sql', foreground: '93c5fd' },
          { token: 'identifier.sql', foreground: 'e2e8f0' },
          { token: 'predefined.sql', foreground: 'f472b6' },
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
          'editorIndentGuide.background': '#ffffff10',
          'editorIndentGuide.activeBackground': '#ffffff20',
          'editor.selectionHighlightBackground': '#0ea5e915',
          'editorGutter.background': '#00000000',
          'minimap.background': '#00000000',
        },
      })
      monaco.editor.setTheme('suwu-db')

      // Add keyboard shortcut: Ctrl+Enter / Cmd+Enter to execute
      editor.addAction({
        id: 'execute-sql',
        label: 'Execute SQL',
        keybindings: [
          monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter,
        ],
        run: () => {
          onExecute()
        },
      })

      // Focus the editor
      editor.focus()
    },
    [onExecute],
  )

  const handleChange = useCallback(
    (val: string | undefined) => {
      onChange(val ?? '')
    },
    [onChange],
  )

  return (
    <div className="h-full w-full overflow-hidden rounded-lg border border-white/[0.10] bg-white/[0.02]">
      <Editor
        defaultLanguage="sql"
        theme="suwu-db"
        value={value}
        onChange={handleChange}
        onMount={handleMount}
        options={{
          readOnly,
          minimap: { enabled: false },
          fontSize: 13,
          fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
          fontLigatures: true,
          lineNumbers: 'on',
          glyphMargin: false,
          folding: false,
          lineDecorationsWidth: 0,
          lineNumbersMinChars: 3,
          renderLineHighlight: 'line',
          scrollBeyondLastLine: false,
          wordWrap: 'on',
          automaticLayout: true,
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
            vertical: 'hidden',
            horizontal: 'auto',
            verticalScrollbarSize: 0,
            horizontalScrollbarSize: 6,
          },
        }}
        loading={
          <div className="flex h-full items-center justify-center text-white/40">
            Loading editor...
          </div>
        }
      />
    </div>
  )
}
