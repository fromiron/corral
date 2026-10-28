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
