import { useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { filterExtensionSuggestions, normalizeExtensionToken } from './search';

interface Props {
  value: string[];
  onChange: (value: string[]) => void;
  /** Ranked candidates, typically disk extensions merged with a static seed. */
  suggestions: string[];
  disabled?: boolean;
  id?: string;
}

/**
 * Multi-value file-extension input: removable chips plus a typeahead that
 * filters `suggestions`. Enter/comma commits the typed token, or the
 * highlighted suggestion when one is active. A blank value searches every
 * extension.
 */
export function ExtensionPicker({ value, onChange, suggestions, disabled, id }: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const options = useMemo(
    () => filterExtensionSuggestions(suggestions, query, value),
    [suggestions, query, value],
  );
  const typed = normalizeExtensionToken(query);
  const canAddTyped =
    typed !== null && !value.some((extension) => extension.toLowerCase() === typed.toLowerCase());

  const commit = (extension: string) => {
    if (!value.some((item) => item.toLowerCase() === extension.toLowerCase())) {
      onChange([...value, extension]);
    }
    setQuery('');
    setActive(-1);
    setOpen(true);
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((current) => Math.min(options.length - 1, current + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => Math.max(-1, current - 1));
    } else if (event.key === 'Enter') {
      if (canAddTyped) {
        event.preventDefault();
        commit(typed);
      } else if (open && active >= 0 && options[active]) {
        event.preventDefault();
        commit(options[active]);
      }
      // Otherwise let Enter submit the surrounding search form.
    } else if (event.key === ',' || (event.key === ' ' && canAddTyped)) {
      event.preventDefault();
      if (canAddTyped) commit(typed);
    } else if (event.key === 'Backspace' && query === '' && value.length > 0) {
      event.preventDefault();
      onChange(value.slice(0, -1));
    } else if (event.key === 'Escape') {
      setOpen(false);
      setQuery('');
      setActive(-1);
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <div className="flex min-h-8 w-full flex-wrap items-center gap-1 rounded border border-white/15 bg-black/20 px-2 py-1 focus-within:border-white/40">
        {value.map((extension) => (
          <span
            key={extension}
            className="flex items-center gap-0.5 rounded bg-white/10 py-0.5 pl-1.5 pr-0.5 text-[10px] text-white/80"
          >
            <span className="font-mono">.{extension}</span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(value.filter((item) => item !== extension))}
              aria-label={t('codeExplorer.search.removeExtension', { extension })}
              className="grid h-3.5 w-3.5 place-items-center rounded text-white/50 transition hover:bg-white/15 hover:text-white disabled:opacity-40"
            >
              <svg
                className="h-2.5 w-2.5"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </span>
        ))}
        <input
          id={id}
          ref={inputRef}
          role="combobox"
          aria-expanded={open && options.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          value={query}
          disabled={disabled}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(-1);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          placeholder={
            value.length === 0
              ? t('codeExplorer.search.allExtensions')
              : t('codeExplorer.search.addExtension')
          }
          className="min-w-[4rem] flex-1 bg-transparent px-0.5 py-0.5 font-mono text-sm text-white/90 outline-none placeholder:font-sans placeholder:text-white/30"
        />
      </div>
      {open && options.length > 0 && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('codeExplorer.search.extensionSuggestions')}
          className="menu-glass scrollbar-thin absolute inset-x-0 z-20 mt-1 max-h-52 overflow-auto rounded-[6px] border border-white/10 p-1"
        >
          {options.map((extension, index) => (
            <li
              key={extension}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
            >
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commit(extension)}
                onMouseEnter={() => setActive(index)}
                className={`flex w-full items-center rounded px-2 py-1 text-left font-mono text-xs transition ${
                  index === active ? 'bg-white/10 text-white' : 'text-white/70 hover:text-white'
                }`}
              >
                .{extension}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
