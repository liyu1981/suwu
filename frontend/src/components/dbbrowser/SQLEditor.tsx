import { useRef, useCallback } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { MONACO_THEME, ensureMonacoTheme } from '../codeexplorer/monacoSetup'

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

      ensureMonacoTheme(monaco)

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
        theme={MONACO_THEME}
        value={value}
        onChange={handleChange}
        onMount={handleMount}
        options={{
          readOnly,
          minimap: { enabled: false },
          fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
          fontSize: 14,
          fontLigatures: true,
          lineNumbers: 'on',
          glyphMargin: false,
          folding: false,
          lineDecorationsWidth: 16,
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
          <div className="flex h-full items-center justify-center text-[11px] text-white/40">
            Loading editor...
          </div>
        }
      />
    </div>
  )
}
