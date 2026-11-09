import type { ReviewCommentView } from '@corral/client';
import { Button, Textarea } from '@corral/react/design-kit';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { type CommentKind, composeCommentBody, parseCommentBody } from './reviewComments.ts';

type Anchor = Pick<ReviewCommentView, 'side' | 'startLine' | 'endLine' | 'quote'>;
const KINDS: { kind: CommentKind; label: 'kindComment' | 'kindDelete' | 'kindReplace' }[] = [
  { kind: 'comment', label: 'kindComment' },
  { kind: 'delete', label: 'kindDelete' },
  { kind: 'replace', label: 'kindReplace' },
];
/** The server's limit for a comment body. */
const BODY_LIMIT = 10_000;

/**
 * A new comment on a line range: a comment, a suggested deletion or a suggested replacement.
 * Suggestions only shape the body (reviewComments.ts); saving one is saving a draft comment.
 */
export function ReviewCommentForm({
  anchor,
  onSubmit,
  onCancel,
}: {
  anchor: Anchor;
  onSubmit(comment: Anchor & { body: string }): Promise<void>;
  onCancel(): void;
}) {
  const t = useTranslations('Review');
  const tf = useTranslations('Files');
  const id = useId();
  const [kind, setKind] = useState<CommentKind>('comment');
  const [note, setNote] = useState('');
  const [replacement, setReplacement] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    noteField.current?.focus();
  }, []);
  const replaced = replacement ?? anchor.quote;
  const body = composeCommentBody(
    kind === 'comment'
      ? { kind, note }
      : kind === 'delete'
        ? { kind, original: anchor.quote, note }
        : { kind, original: anchor.quote, replacement: replaced, note },
  );
  const ready =
    kind === 'comment' ? note.trim() !== '' : kind === 'delete' || replaced !== anchor.quote;
  const tooLong = body.length > BODY_LIMIT;
  return (
    <form
      className="space-y-2 rounded-lg fill-group p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !ready || tooLong) return;
        setBusy(true);
        setError(null);
        void onSubmit({ ...anchor, body })
          .then(
            () => {
              setNote('');
              setReplacement(null);
              setKind('comment');
            },
            (failure: unknown) =>
              setError(failure instanceof Error ? failure.message : String(failure)),
          )
          .finally(() => setBusy(false));
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <fieldset className="flex flex-wrap gap-0.5" aria-describedby={`${id}-range`}>
          <legend className="sr-only">{t('kindLabel')}</legend>
          {KINDS.map((option) => (
            <Button
              key={option.kind}
              type="button"
              size="compact"
              variant={kind === option.kind ? 'secondary' : 'ghost'}
              aria-pressed={kind === option.kind}
              onClick={() => setKind(option.kind)}
            >
              {t(option.label)}
            </Button>
          ))}
        </fieldset>
        <p id={`${id}-range`} className="text-caption text-muted-foreground">
          {anchor.side === 'before' ? tf('before') : tf('after')} · {anchor.startLine}–
          {anchor.endLine}
        </p>
      </div>
      {kind === 'replace' ? (
        <label className="flex flex-col gap-1 text-caption text-muted-foreground">
          {t('replaceWith')}
          <Textarea
            aria-label={t('replaceWith')}
            value={replaced}
            onChange={(event) => setReplacement(event.target.value)}
            rows={Math.min(8, Math.max(2, replaced.split('\n').length))}
            className="w-full font-mono"
          />
        </label>
      ) : null}
      <Textarea
        ref={noteField}
        aria-label={t('commentLine', { line: anchor.startLine })}
        placeholder={t(kind === 'comment' ? 'commentPlaceholder' : 'suggestionNote')}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        className="w-full"
      />
      <div className="flex gap-2">
        <Button type="submit" size="compact" disabled={busy || !ready || tooLong}>
          {t('addComment')}
        </Button>
        <Button type="button" size="compact" variant="ghost" onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
      {tooLong ? (
        <p role="alert" className="text-caption text-destructive">
          {t('commentTooLong')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-caption text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** A stored comment's body as its kind shows it: the note, and what a suggestion proposes. */
export function CommentBody({ body }: { body: string }) {
  const t = useTranslations('Review');
  const parsed = parseCommentBody(body);
  if (parsed.kind === 'comment') return <>{parsed.note}</>;
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="text-muted-foreground">{t(`kinds.${parsed.kind}`)}</span>
      {parsed.kind === 'replace' ? (
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-sm fill-group px-1.5 py-1 font-mono">
          {parsed.replacement}
        </pre>
      ) : null}
      {parsed.note.trim() ? <span>{parsed.note}</span> : null}
    </span>
  );
}
