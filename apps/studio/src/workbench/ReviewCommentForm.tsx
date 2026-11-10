import type { ReviewCommentView } from '@corral/client';
import { Button, Input, Select, Textarea } from '@corral/react/design-kit';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { type CommentKind, composeCommentBody, parseCommentBody } from './reviewComments.ts';

type Anchor = Pick<ReviewCommentView, 'side' | 'startLine' | 'endLine' | 'quote'>;
/** The line range a comment is about, as the form's own inputs edit it. */
export interface CommentRange {
  side: Anchor['side'];
  start: number;
  end: number;
}
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
 * The range comes from the lines picked in the diff; with `onRange` the form also lets it be
 * typed (side, first and last line), and `anchor` is null while that range is not in the file.
 */
export function ReviewCommentForm({
  anchor,
  path,
  range,
  onRange,
  onSubmit,
  onCancel,
}: {
  anchor: Anchor | null;
  /** The file the comment is about, named at the head of the form. */
  path?: string;
  range?: CommentRange;
  onRange?(range: CommentRange): void;
  onSubmit(comment: Anchor & { body: string }): Promise<void>;
  onCancel(): void;
}) {
  const t = useTranslations('Review');
  const tf = useTranslations('Files');
  const td = useTranslations('Desktop');
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
  const quote = anchor?.quote ?? '';
  const replaced = replacement ?? quote;
  const body = composeCommentBody(
    kind === 'comment'
      ? { kind, note }
      : kind === 'delete'
        ? { kind, original: quote, note }
        : { kind, original: quote, replacement: replaced, note },
  );
  const ready =
    anchor !== null &&
    (kind === 'comment' ? note.trim() !== '' : kind === 'delete' || replaced !== quote);
  const tooLong = body.length > BODY_LIMIT;
  const firstLine = anchor?.startLine ?? Math.min(range?.start ?? 1, range?.end ?? 1);
  const line = (value: number) => (Number.isInteger(value) && value >= 1 ? value : 1);
  return (
    <form
      className="flex flex-col gap-2 fill-group p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !anchor || !ready || tooLong) return;
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
      {/* What the comment is about, and what kind it is. Three kinds fit one compact choice at
          any width and in either language. */}
      <div className="flex min-w-0 items-center gap-2">
        {/* A long path keeps its file name: it is cut at the start. */}
        <p
          id={`${id}-range`}
          dir={path ? 'rtl' : undefined}
          className="m-0 min-w-0 flex-1 truncate text-left font-mono text-caption text-muted-foreground"
          title={path}
        >
          {path ? (
            <bdi>{path}</bdi>
          ) : anchor ? (
            `${anchor.side === 'before' ? tf('before') : tf('after')} · ${anchor.startLine}–${anchor.endLine}`
          ) : null}
        </p>
        <Select
          variant="chip"
          label={t('kindLabel')}
          align="end"
          value={kind}
          onValueChange={setKind}
          options={KINDS.map((option) => ({ value: option.kind, label: t(option.label) }))}
        />
      </div>
      {range && onRange ? (
        <div className="flex items-center gap-1.5 text-caption text-muted-foreground">
          <div className="min-w-0 flex-1">
            <Select
              label={td('commentSide')}
              size="xs"
              className="w-full min-w-0"
              value={range.side}
              onValueChange={(side) => onRange({ ...range, side })}
              options={[
                { value: 'before' as const, label: tf('before') },
                { value: 'after' as const, label: tf('after') },
              ]}
            />
          </div>
          <Input
            type="number"
            size="compact"
            font="mono"
            min={1}
            aria-label={td('fromLine')}
            aria-invalid={anchor ? undefined : true}
            value={range.start}
            onChange={(event) => onRange({ ...range, start: line(event.target.valueAsNumber) })}
            className="w-16 shrink-0"
          />
          <span aria-hidden>–</span>
          <Input
            type="number"
            size="compact"
            font="mono"
            min={1}
            aria-label={td('toLine')}
            aria-invalid={anchor ? undefined : true}
            value={range.end}
            onChange={(event) => onRange({ ...range, end: line(event.target.valueAsNumber) })}
            className="w-16 shrink-0"
          />
        </div>
      ) : null}
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
        aria-label={t('commentLine', { line: firstLine })}
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
        <p role="alert" className="m-0 text-caption text-destructive">
          {t('commentTooLong')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 text-caption text-destructive">
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
        <pre className="m-0 max-h-32 overflow-auto rounded-sm fill-group px-1.5 py-1 font-mono break-all whitespace-pre-wrap">
          {parsed.replacement}
        </pre>
      ) : null}
      {parsed.note.trim() ? <span>{parsed.note}</span> : null}
    </span>
  );
}
