import type { FileSideView, ReviewCommentView } from '@corral/client';

// Review comments come in three kinds (workbench.md): a comment, a suggested deletion and a
// suggested replacement. A suggestion is only a body format: the server stores and sends the
// body like any comment, and nothing here writes a file. The first line names the kind with a
// fixed English marker, so a body reads back to its kind in any interface language.

export type CommentKind = 'comment' | 'delete' | 'replace';
type SuggestionKind = Exclude<CommentKind, 'comment'>;

/** The first body line of a suggestion; never translated. */
export const SUGGESTION_MARKERS: Record<SuggestionKind, string> = {
  delete: 'Suggested deletion: remove the original lines.',
  replace: 'Suggested replacement: replace the original lines with the replacement.',
};

export type CommentDraft =
  | { kind: 'comment'; note: string }
  | { kind: 'delete'; original: string; note: string }
  | { kind: 'replace'; original: string; replacement: string; note: string };

/** A fence longer than any backtick run in the text, so the text can never close it. */
function fenced(info: 'original' | 'replacement', text: string) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${text}\n${fence}`;
}

export function composeCommentBody(draft: CommentDraft): string {
  if (draft.kind === 'comment') return draft.note;
  const parts = [SUGGESTION_MARKERS[draft.kind], fenced('original', draft.original)];
  if (draft.kind === 'replace') parts.push(fenced('replacement', draft.replacement));
  const note = draft.note.trim();
  if (note) parts.push(note);
  return parts.join('\n');
}

const BLOCK = /^(`{3,})(original|replacement)\n([\s\S]*?)\n\1(?:\n|$)/;

/** The kind and parts of a stored body; anything that is not a whole suggestion is a comment. */
export function parseCommentBody(body: string): CommentDraft {
  const kind = (['delete', 'replace'] as const).find((value) =>
    body.startsWith(`${SUGGESTION_MARKERS[value]}\n`),
  );
  if (!kind) return { kind: 'comment', note: body };
  let rest = body.slice(SUGGESTION_MARKERS[kind].length + 1);
  const take = (info: 'original' | 'replacement') => {
    const match = BLOCK.exec(rest);
    if (!match || match[2] !== info) return null;
    rest = rest.slice(match[0].length);
    return match[3] as string;
  };
  const original = take('original');
  if (original === null) return { kind: 'comment', note: body };
  if (kind === 'delete') return { kind, original, note: rest };
  const replacement = take('replacement');
  if (replacement === null) return { kind: 'comment', note: body };
  return { kind, original, replacement, note: rest };
}

/** The lines `startLine`–`endLine` of a text, or null when the range is not in it. */
export function quoteAt(text: string, startLine: number, endLine: number): string | null {
  const lines = text.split('\n');
  if (startLine < 1 || endLine < startLine || endLine > lines.length) return null;
  return lines.slice(startLine - 1, endLine).join('\n');
}

/** A side's text as a comment quotes it; null when it is not text (binary, too large). */
export const sideText = (side: FileSideView): string | null =>
  side.kind === 'text' ? side.text : side.kind === 'absent' ? '' : null;

/**
 * Whether a sent comment's pinned quote no longer matches the same lines of the current
 * comparison; null when that side cannot be read as text.
 */
export function rangeChanged(
  comment: Pick<ReviewCommentView, 'side' | 'startLine' | 'endLine' | 'quote'>,
  current: { before: string | null; after: string | null },
): boolean | null {
  const text = comment.side === 'before' ? current.before : current.after;
  if (text === null) return null;
  return quoteAt(text, comment.startLine, comment.endLine) !== comment.quote;
}
