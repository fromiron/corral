// The note beside the picked element (features/browser-annotate.md 주석 칸): its element's name,
// the note's text, the screenshot and console toggles, collect, and send or add; under them the
// reason a toggle or add can't be used, and why the last send didn't go.
import { Button, Elevated, Switch, Textarea, Tooltip } from '@corral/react/design-kit';
import { ImageIcon, LoaderCircle, Terminal } from '@corral/react/icons';
import {
  type CSSProperties,
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
} from 'react';
import { useTranslations } from 'use-intl';

export interface NoteView {
  label: string;
  text: string;
  /** The text can't change: sending, adding, or its answer was lost. */
  locked: boolean;
  /** Sending or adding: the button shows its progress and takes no second press. */
  busy: boolean;
  intent: 'send' | 'add';
  canSubmit: boolean;
  shot: { on: boolean; blocked: string | null };
  /** Preview pages only. */
  console: boolean | null;
  collect: { on: boolean; disabled: boolean };
  /** Under the note: why add can't be used now. */
  addBlocked: string | null;
  /** Under the note: why the last send or add didn't go. */
  failure: string | null;
  /** The answer was lost: the composer's sentence and "다시 보내기". */
  unconfirmed: string | null;
}

export interface NoteActions {
  onText(text: string): void;
  onTextKey(event: KeyboardEvent<HTMLTextAreaElement>): void;
  onShot(): void;
  onConsole(): void;
  onCollect(): void;
  onSubmit(): void;
  onSendAgain(): void;
  onHeight(height: number): void;
}

export function NoteCard({
  view,
  actions,
  style,
  ghost = false,
  onKeyDown,
  onAnimationEnd,
}: {
  view: NoteView;
  actions: NoteActions;
  style: CSSProperties;
  /** A copy playing the note's exit: inert and unread. */
  ghost?: boolean;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onAnimationEnd?: () => void;
}) {
  const t = useTranslations('Annotate');
  const card = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const shotReason = useId();
  const heightOf = useRef(actions.onHeight);
  heightOf.current = actions.onHeight;

  useEffect(() => {
    if (!ghost) text.current?.focus();
  }, [ghost]);

  useLayoutEffect(() => {
    const element = card.current;
    if (!element || ghost) return;
    heightOf.current(element.offsetHeight);
    const observer = new ResizeObserver(() => heightOf.current(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ghost]);

  return (
    <div
      ref={card}
      data-annotate={ghost ? 'note-leaving' : 'note'}
      style={style}
      inert={ghost}
      aria-hidden={ghost || undefined}
      className={`absolute left-0 top-0 ${ghost ? 'annotate-shrink pointer-events-none' : 'annotate-grow'}`}
      onKeyDown={onKeyDown}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) onAnimationEnd?.();
      }}
    >
      <Elevated
        offset={2}
        className="flex flex-col gap-1 rounded-xl p-1.5 text-body text-foreground"
      >
        <div className="flex min-w-0 items-center px-1.5 pt-0.5">
          <span className="min-w-0 truncate font-mono text-caption text-muted-foreground">
            {view.label}
          </span>
        </div>
        <Textarea
          ref={text}
          unstyled
          rows={1}
          value={view.text}
          maxLength={4000}
          readOnly={view.locked}
          aria-label={t('noteLabel', { label: view.label })}
          placeholder={t('placeholder')}
          onChange={(event) => actions.onText(event.currentTarget.value)}
          onKeyDown={actions.onTextKey}
          className="[&_textarea]:max-h-[120px] [&_textarea]:min-h-0 [&_textarea]:resize-none [&_textarea]:px-1.5 [&_textarea]:py-1"
        />
        <div className="flex items-center gap-0.5">
          <Tooltip content={t('screenshot')}>
            <Button
              variant="ghost"
              size="icon-compact"
              aria-label={t('screenshot')}
              aria-pressed={view.shot.on}
              aria-describedby={view.shot.blocked ? shotReason : undefined}
              disabled={view.shot.blocked !== null || view.locked}
              onClick={actions.onShot}
              className="aria-pressed:bg-[var(--tint)] aria-pressed:text-foreground text-muted-foreground"
            >
              <ImageIcon />
            </Button>
          </Tooltip>
          {view.console !== null && (
            <Tooltip content={t('console')}>
              <Button
                variant="ghost"
                size="icon-compact"
                aria-label={t('console')}
                aria-pressed={view.console}
                disabled={view.locked}
                onClick={actions.onConsole}
                className="aria-pressed:bg-[var(--tint)] aria-pressed:text-foreground text-muted-foreground"
              >
                <Terminal />
              </Button>
            </Tooltip>
          )}
          <div className="ml-auto flex items-center gap-1">
            <Switch
              size="compact"
              label={t('collect')}
              checked={view.collect.on}
              disabled={view.collect.disabled}
              onToggle={actions.onCollect}
            />
            <Button
              variant="primary"
              size="compact"
              disabled={!view.canSubmit || view.busy || view.locked}
              aria-busy={view.busy || undefined}
              onClick={actions.onSubmit}
            >
              {view.busy && <LoaderCircle className="animate-spin motion-reduce:animate-none" />}
              {view.intent === 'add' ? t('add') : t('send')}
            </Button>
          </div>
        </div>
        {view.shot.blocked && (
          <p id={shotReason} className="px-1.5 text-caption text-muted-foreground">
            {view.shot.blocked}
          </p>
        )}
        {view.addBlocked && (
          <p className="px-1.5 text-caption text-muted-foreground">{view.addBlocked}</p>
        )}
        {view.failure && (
          <p data-annotate="failure" role="status" className="px-1.5 text-caption text-destructive">
            {view.failure}
          </p>
        )}
        {view.unconfirmed && (
          <div className="flex flex-col items-start gap-1 px-1.5 pb-0.5">
            <p role="status" className="text-caption text-muted-foreground">
              {view.unconfirmed}
            </p>
            <Button variant="secondary" size="compact" onClick={actions.onSendAgain}>
              {t('sendAgain')}
            </Button>
          </div>
        )}
      </Elevated>
    </div>
  );
}
