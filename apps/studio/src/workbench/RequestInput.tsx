import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { type FileReference, referenceText } from './FilePanel.tsx';
import { useWorkspaceFiles } from './useWorkspaceFiles.ts';

/** File mentions use Corral's scoped, read-only file catalog. */
export function RequestInput({
  value,
  onChange,
  onKeyDown,
  projectId,
  sessionId,
  reference,
  onReferenceUsed,
}: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  projectId: string;
  sessionId: string;
  reference: FileReference | null;
  onReferenceUsed: () => void;
}) {
  const t = useTranslations('Desktop');
  const ts = useTranslations('Sessions');
  const input = useRef<HTMLTextAreaElement>(null);
  const used = useRef<FileReference | null>(null);
  const [caret, setCaret] = useState(value.length);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
  const query = match?.[1];
  const show = query !== undefined && dismissed !== value;
  const { list } = useWorkspaceFiles(projectId, sessionId, undefined, show);
  const matches = show
    ? list.files.filter((f) => f.path.toLowerCase().includes(query.toLowerCase())).slice(0, 8)
    : [];
  const selected = Math.min(index, matches.length - 1);
  const insert = (
    text: string,
    start = input.current?.selectionStart ?? value.length,
    end = input.current?.selectionEnd ?? value.length,
  ) => {
    const prefix = value.slice(0, start);
    const next = `${prefix}${prefix && !/\s$/.test(prefix) ? ' ' : ''}${text} ${value.slice(end)}`;
    onChange(next);
    setDismissed(next);
    requestAnimationFrame(() => {
      input.current?.focus();
      const position = next.length - value.slice(end).length;
      input.current?.setSelectionRange(position, position);
      setCaret(position);
    });
  };
  useEffect(() => {
    if (!reference || used.current === reference) return;
    used.current = reference;
    insert(referenceText(reference));
    onReferenceUsed();
  });
  useLayoutEffect(() => {
    if (!input.current) return;
    void value;
    input.current.style.height = 'auto';
    input.current.style.height = `${Math.min(180, input.current.scrollHeight)}px`;
  }, [value]);
  const choose = (path: string) =>
    insert(
      `@${path.includes(' ') ? JSON.stringify(path) : path}`,
      caret - (query?.length ?? 0) - 1,
      caret,
    );
  return (
    <div className="relative">
      {matches.length ? (
        <div
          id="file-mentions"
          role="listbox"
          aria-label={t('fileReferences')}
          className="absolute bottom-full z-30 mb-2 max-h-64 w-full overflow-auto rounded-lg border border-line bg-popover p-1 shadow-lg"
        >
          {matches.map((file, i) => (
            <button
              key={file.path}
              id={`file-mention-${i}`}
              type="button"
              role="option"
              aria-selected={selected === i}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(file.path)}
              className={`w-full truncate rounded px-2 py-1.5 text-left font-mono text-xs ${selected === i ? 'bg-sidebar-selected' : ''}`}
            >
              {file.path}
            </button>
          ))}
        </div>
      ) : null}
      <textarea
        ref={input}
        aria-label={ts('requestLabel')}
        aria-autocomplete="list"
        aria-controls={matches.length ? 'file-mentions' : undefined}
        aria-activedescendant={matches.length ? `file-mention-${selected}` : undefined}
        value={value}
        placeholder={t('requestPlaceholder')}
        rows={2}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onChange={(e) => {
          setCaret(e.target.selectionStart);
          setIndex(0);
          onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (matches.length && !e.ctrlKey && !e.metaKey) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex(
                (selected + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length,
              );
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setDismissed(value);
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              const file = matches[selected];
              if (file) choose(file.path);
              return;
            }
          }
          onKeyDown(e);
        }}
        className="w-full resize-none border-0 bg-transparent p-1 text-sm leading-6 outline-none focus-visible:outline-none"
      />
    </div>
  );
}
