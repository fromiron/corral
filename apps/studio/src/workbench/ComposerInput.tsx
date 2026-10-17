// The composer's text box with one menu for `/` commands and `@` references (CR-016), after
// T3 Code's ComposerCommandMenu (MIT; see THIRD-PARTY-NOTICES/T3-Code.md): one list, grouped,
// keyboard first, IME safe. The renderer only reads names; picking a file grants nothing.
import { rankFuzzy } from '@corral/core';
import { Bot, File, FileText, Folder, History, type LucideIcon, Slash } from '@corral/react/icons';
import { Kbd } from '@corral/react/ui';
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import type { AppCommand } from '../commandRegistry.ts';
import {
  type MentionItem,
  type MentionKind,
  mentionToken,
  replaceTrigger,
  type Trigger,
  triggerAt,
} from './composerMenu.ts';

const ICON: Record<MentionKind, LucideIcon> = {
  file: File,
  folder: Folder,
  result: FileText,
  run: History,
  role: Bot,
};

type Row =
  | { kind: 'command'; id: string; command: AppCommand }
  | { kind: 'mention'; id: string; item: MentionItem };

export function ComposerInput({
  value,
  onChange,
  onKeyDown,
  commands,
  searchMentions,
  onMention,
  inputRef,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Keys the menu does not take (sending, history). */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  commands: AppCommand[];
  searchMentions: (query: string) => Promise<MentionItem[]>;
  onMention: (item: MentionItem) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  placeholder: string;
  label: string;
}) {
  const t = useTranslations('Composer');
  const listId = useId();
  const [caret, setCaret] = useState(value.length);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [mentions, setMentions] = useState<{ query: string; items: MentionItem[] } | null>(null);
  const trigger: Trigger | null = dismissed === value ? null : triggerAt(value, caret);
  const query = trigger?.query ?? null;
  const kind = trigger?.kind ?? null;

  useEffect(() => {
    if (kind !== 'mention' || query === null) return;
    let live = true;
    const timer = setTimeout(
      () =>
        void searchMentions(query).then(
          (items) => live && setMentions({ query, items }),
          () => live && setMentions({ query, items: [] }),
        ),
      query ? 80 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [kind, query, searchMentions]);

  const rows: Row[] =
    kind === 'slash'
      ? rankFuzzy(
          query ?? '',
          commands.filter((c) => c.slash && !c.disabled),
          (c) => `${c.slash} ${c.title} ${(c.keywords ?? []).join(' ')}`,
          12,
        ).map((command) => ({ kind: 'command', id: command.id, command }))
      : kind === 'mention' && mentions
        ? mentions.items.map((item) => ({ kind: 'mention', id: item.id, item }))
        : [];
  const open = kind !== null && (kind === 'slash' || mentions !== null);
  const selected = Math.min(index, Math.max(0, rows.length - 1));

  useLayoutEffect(() => {
    const box = inputRef.current;
    if (!box) return;
    void value;
    box.style.height = 'auto';
    box.style.height = `${Math.min(240, box.scrollHeight)}px`;
  }, [value, inputRef]);

  const put = (next: { text: string; caret: number }) => {
    onChange(next.text);
    setDismissed(null);
    setMentions(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  };
  const choose = (row: Row | undefined) => {
    if (!row || !trigger) return;
    if (row.kind === 'command') {
      if (row.command.disabled) return;
      // A command replaces what was typed for it; the rest of the request stays.
      const rest = value.slice(trigger.end).replace(/^\s+/, '');
      put({ text: rest, caret: 0 });
      void row.command.run();
      return;
    }
    onMention(row.item);
    put(replaceTrigger(value, trigger, mentionToken(row.item)));
  };

  // One heading per group, in the order groups first appear; rows keep their rank inside.
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const title =
      row.kind === 'command' ? row.command.group : t(`group.${row.item.kind}` as 'group.file');
    grouped.set(title, [...(grouped.get(title) ?? []), row]);
  }
  const groups = [...grouped].map(([title, list]) => ({ title, rows: list }));
  const ordered = groups.flatMap((g) => g.rows);
  let position = -1;

  return (
    <div className="relative">
      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label={kind === 'slash' ? t('commands') : t('references')}
          className="dropdown-glass absolute bottom-full left-0 z-30 mb-2 max-h-72 w-full overflow-auto rounded-xl p-1 shadow-popup"
        >
          {rows.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted">
              {kind === 'slash' ? t('noCommand') : t('noReference')}
            </p>
          ) : null}
          {groups.map((group) => (
            // biome-ignore lint/a11y/useSemanticElements: a listbox's option groups are ARIA groups
            <div key={group.title} role="group" aria-label={group.title}>
              <p className="px-2 pt-1.5 pb-0.5 text-2xs font-medium text-muted">{group.title}</p>
              {group.rows.map((row) => {
                position += 1;
                const at = position;
                const Icon = row.kind === 'command' ? Slash : ICON[row.item.kind];
                const name = row.kind === 'command' ? `/${row.command.slash}` : row.item.label;
                const detail =
                  row.kind === 'command'
                    ? row.command.disabled
                      ? row.command.hint
                      : row.command.title
                    : row.item.detail;
                return (
                  <div
                    key={row.id}
                    id={`${listId}-${at}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={selected === at}
                    aria-disabled={
                      row.kind === 'command' && row.command.disabled ? true : undefined
                    }
                    onMouseEnter={() => setIndex(at)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      choose(row);
                    }}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${selected === at ? 'bg-subtle' : ''} ${row.kind === 'command' && row.command.disabled ? 'opacity-50' : ''}`}
                  >
                    <Icon className="size-4 shrink-0 text-muted" aria-hidden="true" />
                    <span
                      className={`max-w-[45%] shrink-0 truncate font-medium ${row.kind === 'mention' && (row.item.kind === 'file' || row.item.kind === 'folder') ? 'font-mono' : ''}`}
                    >
                      {name}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted">{detail}</span>
                    {row.kind === 'command' && row.command.shortcut ? (
                      <Kbd>{row.command.shortcut}</Kbd>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
      <textarea
        ref={inputRef}
        aria-label={label}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && rows.length ? `${listId}-${selected}` : undefined}
        value={value}
        placeholder={placeholder}
        rows={1}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onChange={(e) => {
          setCaret(e.target.selectionStart);
          setIndex(0);
          onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (open && !e.ctrlKey && !e.metaKey && !e.altKey) {
            if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && rows.length) {
              e.preventDefault();
              setIndex((selected + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setDismissed(value);
              return;
            }
            if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && rows.length) {
              e.preventDefault();
              choose(ordered[selected]);
              return;
            }
          }
          onKeyDown(e);
        }}
        className="block max-h-60 min-h-11 w-full resize-none border-0 bg-transparent px-1 py-1 text-sm leading-6 outline-none placeholder:text-muted/80 focus-visible:outline-none"
      />
    </div>
  );
}
