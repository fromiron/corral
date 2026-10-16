import { useNavigate } from '@tanstack/react-router';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import { type Command, rankCommands } from './commands.ts';
import { useServices } from './services.tsx';
import { createFromTemplate, WORKSPACE_TEMPLATES } from './templates.ts';

const isMac = () => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');
export const modKey = () => (isMac() ? '⌘' : 'Ctrl');

/** True while the user types in a field or composes with an IME: global keys stay quiet. */
function typing(event: globalThis.KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229) return true;
  const target = event.target as HTMLElement | null;
  return Boolean(
    target &&
      (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)),
  );
}

/**
 * ⌘K / Ctrl+K command palette and ? shortcut help for the whole Studio (roadmap UX-A5).
 * Modal, keyboard first, IME safe; focus returns where it was on close.
 */
export function CommandLayer() {
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const returnTo = useRef<HTMLElement | null>(null);
  const open = useCallback((which: 'palette' | 'help') => {
    returnTo.current = document.activeElement as HTMLElement | null;
    if (which === 'palette') setPalette(true);
    else setHelp(true);
  }, []);
  const close = useCallback(() => {
    setPalette(false);
    setHelp(false);
    const target = returnTo.current;
    queueMicrotask(() => target?.focus());
  }, []);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (help && event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (palette) close();
        else open('palette');
      } else if (event.key === '?' && !typing(event) && !palette && !help) {
        event.preventDefault();
        open('help');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [palette, help, open, close]);
  return (
    <>
      {palette ? (
        <Palette
          onClose={close}
          onHelp={() => {
            setPalette(false);
            setHelp(true);
          }}
        />
      ) : null}
      {help ? <ShortcutHelp onClose={close} /> : null}
    </>
  );
}

export function Modal({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]">
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="relative w-[min(36rem,calc(100vw-2rem))] rounded-lg border border-line bg-raised shadow-xl"
      >
        {children}
      </div>
    </div>
  );
}

function Palette({ onClose, onHelp }: { onClose: () => void; onHelp: () => void }) {
  const t = useTranslations('CommandPalette');
  const tw = useTranslations('Workspace');
  const navigate = useNavigate();
  const services = useServices();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [dynamic, setDynamic] = useState<Command[]>([]);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    let live = true;
    void Promise.all([services.repository.list(), services.transport.listRuns()]).then(
      ([corrals, runs]) => {
        if (!live) return;
        setDynamic([
          ...corrals.map(
            (c): Command => ({
              id: `corral:${c.corralId}`,
              title: t('openCorral', { name: c.name }),
              group: t('groups.corrals'),
              run: () =>
                navigate({ to: '/corrals/$corralId/edit', params: { corralId: c.corralId } }),
            }),
          ),
          ...runs.slice(0, 20).map(
            (r): Command => ({
              id: `run:${r.runId}`,
              title: t('openRun', { runId: r.runId }),
              group: t('groups.runs'),
              keywords: [r.status],
              run: () => navigate({ to: '/runs/$runId', params: { runId: r.runId } }),
            }),
          ),
        ]);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [services, navigate, t]);

  const commands = useMemo<Command[]>(() => {
    const fromTemplate = WORKSPACE_TEMPLATES.map(
      (id): Command => ({
        id: `template:${id}`,
        title:
          id === 'blank' ? t('newBlank') : t('newFromTemplate', { name: t(`templates.${id}`) }),
        group: t('groups.create'),
        run: async () => {
          const created = await createFromTemplate(services.repository, id, tw('newName'));
          if (created.ok)
            await navigate({
              to: '/corrals/$corralId/edit',
              params: { corralId: created.corralId },
            });
        },
      }),
    );
    const draftTeam: Command = {
      id: 'create:team-draft',
      title: t('draftTeam'),
      group: t('groups.create'),
      keywords: ['goal', 'team', 'draft', '목표', '팀', '초안'],
      run: () => navigate({ to: '/', search: { draft: true } }),
    };
    const go: Command[] = [
      {
        id: 'go:corrals',
        title: t('goCorrals'),
        group: t('groups.go'),
        run: () => navigate({ to: '/' }),
      },
      {
        id: 'go:demo',
        title: t('goDemo'),
        group: t('groups.go'),
        run: () => {
          window.location.assign('/demo');
        },
      },
      ...(services.mode === 'server'
        ? [
            {
              id: 'go:models',
              title: t('goModels'),
              group: t('groups.go'),
              run: () => navigate({ to: '/settings/models' }),
            },
          ]
        : []),
      { id: 'help', title: t('shortcuts'), group: t('groups.help'), shortcut: '?', run: onHelp },
    ];
    return [draftTeam, ...fromTemplate, ...go, ...dynamic];
  }, [dynamic, services, navigate, t, tw, onHelp]);

  const shown = rankCommands(query, commands);
  const current = Math.min(active, Math.max(0, shown.length - 1));
  const runCommand = async (command: Command | undefined) => {
    if (!command) return;
    onClose();
    await command.run();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current + 1) % Math.max(1, shown.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current - 1 + shown.length) % Math.max(1, shown.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void runCommand(shown[current]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <Modal label={t('label')} onClose={onClose}>
      <input
        ref={inputRef}
        role="combobox"
        aria-label={t('search')}
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={shown[current] ? `${listId}-${current}` : undefined}
        aria-autocomplete="list"
        value={query}
        placeholder={t('placeholder')}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        className="w-full rounded-t-lg border-b border-line bg-transparent px-3 py-2.5 text-sm outline-none"
      />
      <div
        id={listId}
        role="listbox"
        aria-label={t('results')}
        className="max-h-80 overflow-auto p-1"
      >
        {shown.length === 0 ? <p className="px-2 py-1.5 text-sm text-muted">{t('none')}</p> : null}
        {shown.map((command, index) => (
          <div
            key={command.id}
            id={`${listId}-${index}`}
            role="option"
            // Focus stays in the search field; the active option is aria-activedescendant.
            tabIndex={-1}
            aria-selected={index === current}
            onMouseEnter={() => setActive(index)}
            onMouseDown={(event) => {
              event.preventDefault();
              void runCommand(command);
            }}
            className={`flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-sm ${
              index === current ? 'bg-accent/15' : ''
            }`}
          >
            <span>{command.title}</span>
            <span className="text-xs text-muted">{command.shortcut ?? command.group}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const t = useTranslations('Shortcuts');
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  const mod = modKey();
  const rows: [string, string][] = [
    [`${mod} K`, t('palette')],
    ['?', t('help')],
    [`${mod} S`, t('save')],
    [`${mod} Z`, t('undo')],
    [`${mod} Shift Z / ${mod} Y`, t('redo')],
    ['Delete / Backspace', t('delete')],
    ['← ↑ → ↓', t('move')],
    ['Enter', t('send')],
    ['Shift Enter', t('newline')],
    ['Esc', t('close')],
  ];
  return (
    <Modal label={t('label')} onClose={onClose}>
      <div className="flex flex-col gap-2 p-4 text-sm">
        <h2 className="font-semibold">{t('label')}</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          {rows.map(([keys, what]) => (
            <div key={keys} className="contents">
              <dt>
                <kbd className="rounded border border-line px-1 font-mono text-xs">{keys}</kbd>
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="self-end rounded border border-line px-2 py-1 text-xs"
        >
          {t('closeButton')}
        </button>
      </div>
    </Modal>
  );
}
