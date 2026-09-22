import { useCallback } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { MONACO_THEME, ensureMonacoTheme } from '../codeexplorer/monacoSetup';
import { CloseIcon, PlusIcon } from '../icons';
import { Select, SelectContent, SelectItem, SelectTrigger } from '../ui/select';
import {
  BODY_TYPES,
  emptyFormEntry,
  type BodyType,
  type RestFormEntry,
  type RestRequestDraft,
} from '../../store/resthelper';
import KeyValueTable from './KeyValueTable';

interface Props {
  draft: RestRequestDraft;
  patch: (partial: Partial<RestRequestDraft>) => void;
}

const BODY_LABELS: Record<BodyType, string> = {
  none: 'None',
  json: 'JSON',
  raw: 'Raw',
  'form-data': 'Form',
  urlencoded: 'URL-encoded',
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function BodyEditor({ draft, patch }: Props) {
  const handleJsonMount: OnMount = useCallback((_editor, monaco) => {
    ensureMonacoTheme(monaco);
  }, []);

  const updateFormEntry = (id: string, entryPatch: Partial<RestFormEntry>) => {
    patch({
      formData: draft.formData.map((entry) =>
        entry.id === id ? { ...entry, ...entryPatch } : entry,
      ),
    });
  };

  const removeFormEntry = (id: string) => {
    patch({ formData: draft.formData.filter((entry) => entry.id !== id) });
  };

  const addFormEntry = () => {
    patch({ formData: [...draft.formData, emptyFormEntry()] });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1 pb-2">
        {BODY_TYPES.map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => patch({ bodyType: type })}
            className={`rounded-md px-2 py-1 text-xs transition-colors ${
              draft.bodyType === type
                ? 'bg-cyan-500/20 text-cyan-200'
                : 'text-white/40 hover:bg-white/[0.06] hover:text-white/70'
            }`}
          >
            {BODY_LABELS[type]}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-white/[0.08] bg-white/[0.02]">
        {draft.bodyType === 'none' && (
          <div className="flex h-full items-center justify-center text-[11px] text-white/25">
            This request has no body
          </div>
        )}

        {draft.bodyType === 'json' && (
          <Editor
            defaultLanguage="json"
            theme={MONACO_THEME}
            value={draft.body}
            onChange={(value) => patch({ body: value ?? '' })}
            onMount={handleJsonMount}
            options={{
              minimap: { enabled: false },
              fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
              fontSize: 14,
              lineNumbers: 'on',
              folding: true,
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              automaticLayout: true,
              tabSize: 2,
              padding: { top: 8, bottom: 8 },
              formatOnPaste: true,
              scrollbar: {
                vertical: 'auto',
                horizontal: 'auto',
                verticalScrollbarSize: 6,
                horizontalScrollbarSize: 6,
              },
            }}
            loading={
              <div className="flex h-full items-center justify-center text-[11px] text-white/40">
                Loading editor…
              </div>
            }
          />
        )}

        {draft.bodyType === 'raw' && (
          <textarea
            value={draft.body}
            onChange={(event) => patch({ body: event.target.value })}
            placeholder="Raw request body…"
            spellCheck={false}
            className="h-full w-full resize-none bg-transparent p-3 font-mono text-sm text-white/80 outline-none placeholder:text-white/20"
          />
        )}

        {draft.bodyType === 'urlencoded' && (
          <div className="h-full p-1.5">
            <KeyValueTable
              rows={draft.formData}
              onChange={(formData) => patch({ formData })}
              createRow={() => emptyFormEntry({ type: 'text' })}
              addLabel="Add field"
              removeLabel="Remove field"
              enableLabel="Enable field"
            />
          </div>
        )}

        {draft.bodyType === 'form-data' && (
          <div className="flex h-full flex-col">
            <div className="flex shrink-0 items-center justify-between px-3 py-2">
              <span className="text-[10px] uppercase tracking-wider text-white/30">
                Multipart fields
              </span>
              <button
                type="button"
                onClick={addFormEntry}
                className="flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-cyan-300/80 transition-colors hover:bg-cyan-500/15 hover:text-cyan-200"
              >
                <PlusIcon className="h-3 w-3" />
                Add field
              </button>
            </div>
            <div className="min-h-0 flex-1 scrollbar-thin overflow-auto px-2 pb-2">
              {draft.formData.length === 0 ? (
                <div className="flex h-full items-center justify-center text-[11px] text-white/25">
                  No fields
                </div>
              ) : (
                <div className="divide-y divide-white/[0.04] rounded-lg border border-white/[0.08]">
                  {draft.formData.map((entry) => (
                    <div key={entry.id} className="flex items-center gap-2 px-2 py-1">
                      <input
                        type="checkbox"
                        checked={entry.enabled}
                        onChange={(event) =>
                          updateFormEntry(entry.id, { enabled: event.target.checked })
                        }
                        aria-label="Enable field"
                        className="h-3.5 w-3.5 shrink-0 accent-cyan-500"
                      />
                      <input
                        value={entry.key}
                        onChange={(event) => updateFormEntry(entry.id, { key: event.target.value })}
                        placeholder="Key"
                        spellCheck={false}
                        className="w-1/4 min-w-0 rounded bg-transparent px-2 py-1 font-mono text-xs text-white/80 outline-none placeholder:text-white/20 focus:bg-white/[0.05]"
                      />
                      <Select
                        value={entry.type}
                        onValueChange={(value) =>
                          updateFormEntry(entry.id, { type: value as 'text' | 'file' })
                        }
                      >
                        <SelectTrigger
                          aria-label="Field type"
                          className="h-auto w-[72px] shrink-0 justify-between rounded bg-white/[0.06] px-1.5 py-1 text-[11px] text-white/60 focus:ring-0"
                        >
                          <span>{entry.type === 'file' ? 'File' : 'Text'}</span>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="text">Text</SelectItem>
                          <SelectItem value="file">File</SelectItem>
                        </SelectContent>
                      </Select>
                      {entry.type === 'text' ? (
                        <input
                          value={entry.value}
                          onChange={(event) =>
                            updateFormEntry(entry.id, { value: event.target.value })
                          }
                          placeholder="Value"
                          spellCheck={false}
                          className="min-w-0 flex-1 rounded bg-transparent px-2 py-1 font-mono text-xs text-white/70 outline-none placeholder:text-white/20 focus:bg-white/[0.05]"
                        />
                      ) : (
                        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 truncate rounded px-2 py-1 font-mono text-xs text-white/50 hover:bg-white/[0.05]">
                          <span className="truncate">{entry.filename || 'Choose file…'}</span>
                          <input
                            type="file"
                            className="hidden"
                            onChange={async (event) => {
                              const file = event.target.files?.[0];
                              if (!file) return;
                              const contentB64 = await fileToBase64(file);
                              updateFormEntry(entry.id, {
                                filename: file.name,
                                contentB64,
                                contentType: file.type,
                              });
                            }}
                          />
                        </label>
                      )}
                      <button
                        type="button"
                        onClick={() => removeFormEntry(entry.id)}
                        aria-label="Remove field"
                        title="Remove field"
                        className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-white/30 transition-colors hover:bg-rose-500/15 hover:text-rose-300"
                      >
                        <CloseIcon className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
