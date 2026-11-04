import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import {
  AutoReturnToggle,
  SNIPPET_GHOST_BTN,
  SNIPPET_INPUT,
  SNIPPET_PRIMARY_BTN,
} from './SnippetFields';

/**
 * Confirm-and-save for the line the user is currently typing.
 *
 * The menu's *Save current input* used to drop the user into the full manager
 * with an empty "add" form, which meant re-entering the text they had already
 * typed. This dialog seeds the line, lets it be adjusted, offers the one option
 * a snippet has (auto return), and saves — the manager is for curating the
 * shelf, not for creating one entry.
 */
export function SnippetSaveDialog({
  open,
  onOpenChange,
  text,
  onSave,
  onClosed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The line captured when the dialog was opened. */
  text: string;
  onSave: (text: string, autoReturn: boolean) => void;
  /** Called after the dialog closes so the caller can restore focus. */
  onClosed: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(text);
  const [autoReturn, setAutoReturn] = useState(false);

  // Re-seed on every open: the captured line changes between invocations while
  // the dialog component itself stays mounted.
  useEffect(() => {
    if (!open) return;
    setValue(text);
    setAutoReturn(false);
  }, [open, text]);

  const save = () => {
    if (!value.trim()) return;
    onSave(value, autoReturn);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(92vw,32rem)]"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
      >
        <DialogTitle>{t('terminal.snippets.saveCurrent')}</DialogTitle>
        <textarea
          autoFocus
          rows={3}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              save();
            }
          }}
          placeholder={t('terminal.snippets.commandPlaceholder')}
          className={`${SNIPPET_INPUT} mt-3 resize-none`}
        />
        <div className="mt-2">
          <AutoReturnToggle
            id="term-snippet-save-auto-return"
            checked={autoReturn}
            onChange={setAutoReturn}
          />
        </div>
        <div className="mt-4 flex justify-end gap-1">
          <button type="button" onClick={() => onOpenChange(false)} className={SNIPPET_GHOST_BTN}>
            {t('terminal.snippets.cancel')}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!value.trim()}
            className={SNIPPET_PRIMARY_BTN}
          >
            {t('terminal.snippets.save')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
