import type { RunReference } from '@corral/contracts';

// what the composer's `/` and `@` menus read from the text, and what they put back.
// The text keeps a readable token for each reference; the structured reference travels with
// the request only while its token is still in the text.

export type MentionKind = 'file' | 'folder' | 'result' | 'run' | 'role';

export interface MentionItem {
  id: string;
  kind: MentionKind;
  /** Human label: a path, a result name and scope, a run number, or a role name. */
  label: string;
  detail?: string;
  /** A draft-local token bound to this exact reference, independent of its name. */
  token?: string;
  lines?: { start: number; end: number };
  reference: RunReference;
}

export interface Trigger {
  kind: 'slash' | 'mention';
  query: string;
  start: number;
  end: number;
}

/** The open trigger just before the caret, if any. */
export function triggerAt(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const slash = /^\/(\S*)$/.exec(before);
  if (slash) return { kind: 'slash', query: slash[1] ?? '', start: 0, end: caret };
  const mention = /(^|\s)@("?[^\s@"]*)$/.exec(before);
  if (mention) {
    const start = mention.index + (mention[1]?.length ?? 0);
    return { kind: 'mention', query: (mention[2] ?? '').replace(/^"/, ''), start, end: caret };
  }
  return null;
}

/** Replaces the trigger with `token` and a following space; returns the new caret too. */
export function replaceTrigger(
  text: string,
  trigger: Trigger,
  token: string,
): { text: string; caret: number } {
  const head = `${text.slice(0, trigger.start)}${token} `;
  return { text: `${head}${text.slice(trigger.end)}`, caret: head.length };
}

const quoted = (label: string) => (/[\s"]/.test(label) ? JSON.stringify(label) : label);

export function mentionToken(
  item: Pick<MentionItem, 'kind' | 'label' | 'lines' | 'token'>,
): string {
  if (item.token) return item.token;
  const label = item.kind === 'folder' ? `${item.label.replace(/\/+$/, '')}/` : item.label;
  const lines = item.lines
    ? `:L${item.lines.start}${item.lines.end === item.lines.start ? '' : `-L${item.lines.end}`}`
    : '';
  return `@${quoted(label)}${lines}`;
}

export function mentionLabel(item: MentionItem): string {
  return [
    item.token ? item.label : mentionToken(item).slice(1),
    item.kind === 'result' ? item.detail : null,
    item.token,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function selectMention(item: MentionItem, picked: readonly MentionItem[]): MentionItem {
  const existing = picked.find(
    (other) => JSON.stringify(other.reference) === JSON.stringify(item.reference),
  );
  if (existing) return existing;
  if (item.kind !== 'result' && !picked.some((other) => mentionToken(other) === mentionToken(item)))
    return item;
  let number = 1;
  while (picked.some((other) => mentionToken(other) === `@result:${number}`)) number++;
  return { ...item, token: `@result:${number}` };
}

const mentionPattern = (token: string) =>
  new RegExp(`(^|\\s)${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'g');

/** Remove this exact reference, leaving longer paths and line ranges intact. */
export function removeMention(
  text: string,
  item: MentionItem,
  picked: readonly MentionItem[] = [],
): string {
  const token = mentionToken(item);
  const pattern = mentionPattern(token);
  // Older drafts can share a label; keep a token for their remaining exact references.
  const shared = picked.some((other) => other.id !== item.id && mentionToken(other) === token);
  let removals = shared
    ? Math.max(0, Math.min(1, [...text.matchAll(pattern)].length - 1))
    : Infinity;
  return text.replace(pattern, (match, before: string, at: number) => {
    if (removals-- <= 0) return match;
    return before === ' ' && text[at + match.length] === ' ' ? '' : before;
  });
}

/** The references of `picked` whose token is in `text` as a whole word, without repeats. */
export function pickedReferences(text: string, picked: readonly MentionItem[]): RunReference[] {
  const out: RunReference[] = [];
  const seen = new Set<string>();
  for (const item of picked) {
    const found = mentionPattern(mentionToken(item)).test(text);
    const key = JSON.stringify(item.reference);
    if (found && !seen.has(key)) {
      seen.add(key);
      out.push(item.reference);
    }
  }
  return out;
}

// A token as the text holds it: `@` and a quoted label with an optional line range, or a word.
const TOKEN_IN_TEXT = /(^|\s)(@(?:"(?:[^"\\]|\\.)*"(?::L\d+(?:-L\d+)?)?|[^\s"]\S*))(?=\s|$)/g;
const RESULT_TOKEN = /^@result:(\d+)$/;

/**
 * The chips of a saved request's references, taken back into the box with its text. A saved
 * request keeps the references, not the chips, so each is bound again to a token its text holds:
 * a file or folder to its own path token, a result to a `@result:n` token in the order they were
 * numbered, and a run or role to the next token left. A reference whose token is not in the text
 * any more is not restored; it would not be sent either.
 */
export function restoredMentions(text: string, references: readonly RunReference[]): MentionItem[] {
  const tokens = [...text.matchAll(TOKEN_IN_TEXT)].map((match) => match[2] ?? '');
  const used = new Set<number>();
  const take = (fits: (token: string) => boolean) => {
    const index = tokens.findIndex((token, n) => !used.has(n) && fits(token));
    if (index < 0) return null;
    used.add(index);
    return tokens[index] ?? null;
  };
  const own = (reference: RunReference) =>
    reference.kind === 'file' || reference.kind === 'folder'
      ? mentionToken({
          kind: reference.kind,
          label: reference.path,
          ...(reference.kind === 'file' && reference.lines ? { lines: reference.lines } : {}),
        })
      : null;
  const bound = new Map<number, string>();
  references.forEach((reference, n) => {
    const token = own(reference);
    const found = token ? take((value) => value === token) : null;
    if (found) bound.set(n, found);
  });
  const results = tokens
    .filter((token) => RESULT_TOKEN.test(token))
    .sort((a, b) => Number(RESULT_TOKEN.exec(a)?.[1]) - Number(RESULT_TOKEN.exec(b)?.[1]));
  references.forEach((reference, n) => {
    if (reference.kind !== 'result') return;
    const next = results.find((token) => !used.has(tokens.indexOf(token)));
    if (!next) return;
    used.add(tokens.indexOf(next));
    bound.set(n, next);
  });
  references.forEach((reference, n) => {
    if (
      bound.has(n) ||
      reference.kind === 'text_attachment' ||
      reference.kind === 'image_attachment'
    )
      return;
    const found = take((token) => !RESULT_TOKEN.test(token));
    if (found) bound.set(n, found);
  });
  const items: MentionItem[] = [];
  references.forEach((reference, n) => {
    const token = bound.get(n);
    if (!token || reference.kind === 'text_attachment' || reference.kind === 'image_attachment')
      return;
    const id = `${reference.kind}:${JSON.stringify(reference)}`;
    if (token === own(reference) && (reference.kind === 'file' || reference.kind === 'folder')) {
      items.push({
        id,
        kind: reference.kind,
        label: reference.path,
        ...(reference.kind === 'file' && reference.lines ? { lines: reference.lines } : {}),
        reference,
      });
      return;
    }
    const body = token.slice(1);
    let label = body;
    if (body.startsWith('"'))
      try {
        label = JSON.parse(body) as string;
      } catch {
        label = body;
      }
    const item: MentionItem = { id, kind: reference.kind, label, reference };
    // A token the label does not make again (a result's number) is kept as it is.
    items.push(mentionToken(item) === token ? item : { ...item, label: '', token });
  });
  return items;
}

/** Fixed window coordinates for the composer menu. */
export interface MenuPlacement {
  position: 'fixed';
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

// The menu's tallest size (max-h-72) and its gap to the input and the window edge.
const MENU_MAX = 288;
const GAP = 8;

/**
 * Where the menu goes in the window: above the input when it fits there (or has more room
 * than below), else below. It is fixed to the window so a short composer scroller or a
 * clipped dock pane never cuts it off (#93).
 */
export function menuPlacement(
  anchor: { top: number; bottom: number; left: number; width: number },
  viewportHeight: number,
): MenuPlacement {
  const above = anchor.top - GAP * 2;
  const below = viewportHeight - anchor.bottom - GAP * 2;
  const up = above >= MENU_MAX || above >= below;
  return {
    position: 'fixed',
    left: anchor.left,
    width: anchor.width,
    maxHeight: Math.max(96, Math.min(MENU_MAX, up ? above : below)),
    ...(up ? { bottom: viewportHeight - anchor.top + GAP } : { top: anchor.bottom + GAP }),
  };
}
