import type { SessionIntent } from '@corral/core';
import type { MentionItem } from './composerMenu.ts';

// A session's unsent request, kept in this browser (UX-02): the text, what it is for (intent
// and instruction target), and the exact references it carries. Older drafts were text only.

const key = (sessionId: string) => `corral:session-draft:${sessionId}`;
const INTENTS: readonly SessionIntent[] = ['next', 'queue', 'steer', 'explain'];
const KINDS = ['file', 'folder', 'result', 'run', 'role'];

export interface ComposerDraft {
  text: string;
  intent: SessionIntent | null;
  target: string | null;
  /** The target's name when it was chosen ("Research · #1"), shown even after it ends. */
  targetLabel: string | null;
  references: MentionItem[];
}

const empty = (text = ''): ComposerDraft => ({
  text,
  intent: null,
  target: null,
  targetLabel: null,
  references: [],
});

const isMention = (value: unknown): value is MentionItem => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<MentionItem>;
  return (
    typeof item.id === 'string' &&
    typeof item.label === 'string' &&
    typeof item.kind === 'string' &&
    KINDS.includes(item.kind) &&
    !!item.reference &&
    typeof item.reference === 'object' &&
    item.reference.kind === item.kind
  );
};

export function parseComposerDraft(raw: string | null): ComposerDraft {
  if (!raw) return empty();
  if (!raw.startsWith('{"v":2')) return empty(raw);
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return {
      text: typeof value.text === 'string' ? value.text : '',
      intent: INTENTS.includes(value.intent as SessionIntent)
        ? (value.intent as SessionIntent)
        : null,
      target: typeof value.target === 'string' ? value.target : null,
      targetLabel: typeof value.targetLabel === 'string' ? value.targetLabel : null,
      references: Array.isArray(value.references) ? value.references.filter(isMention) : [],
    };
  } catch {
    return empty(raw);
  }
}

export function serializeComposerDraft(draft: ComposerDraft): string | null {
  if (!draft.text && !draft.references.length) return null;
  return JSON.stringify({ v: 2, ...draft });
}

export function readComposerDraft(sessionId: string): ComposerDraft {
  try {
    return parseComposerDraft(window.localStorage.getItem(key(sessionId)));
  } catch {
    return empty();
  }
}

export function writeComposerDraft(sessionId: string, draft: ComposerDraft) {
  try {
    const value = serializeComposerDraft(draft);
    if (value) window.localStorage.setItem(key(sessionId), value);
    else window.localStorage.removeItem(key(sessionId));
  } catch {
    // The draft remains usable in the current page when storage is unavailable.
  }
}

/** The text of a draft (older callers and the new-session purpose). */
export function readDraft(sessionId: string) {
  return readComposerDraft(sessionId).text;
}

export function writeDraft(sessionId: string, text: string) {
  writeComposerDraft(sessionId, empty(text));
}
