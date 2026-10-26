import {
  HarnessBindingRef,
  type ImageAttachment,
  ImageAttachments,
  PermissionMode,
  type TextAttachment,
} from '@corral/contracts';
import type { SessionIntent } from '@corral/core';
import { validTextAttachments } from '@corral/core';
import type { MentionItem } from './composerMenu.ts';

// A session's unsent request, kept in this browser: the text, what it is for (intent
// and instruction target), and the exact references it carries. Older drafts were text only.

const key = (sessionId: string) => `corral:session-draft:${sessionId}`;
const INTENTS: readonly SessionIntent[] = ['next', 'queue', 'steer', 'explain'];
const KINDS = ['file', 'folder', 'result', 'run', 'role'];
export const COMPOSER_DRAFT_SENT = 'corral:composer-draft-sent';
const revisions = new Map<string, { value: string | null; revision: number }>();
const consumed = new Map<string, number>();

export interface ComposerDraft {
  harness?: HarnessBindingRef;
  permissionMode?: PermissionMode;
  images?: ImageAttachment[];
  taskScope?: 'review_only';
  verificationScope?: 'release';
  attachments?: TextAttachment[];
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
      ...(HarnessBindingRef.safeParse(value.harness).success
        ? { harness: HarnessBindingRef.parse(value.harness) }
        : {}),
      ...(PermissionMode.safeParse(value.permissionMode).success
        ? { permissionMode: PermissionMode.parse(value.permissionMode) }
        : {}),
      ...(value.images !== undefined
        ? { images: ImageAttachments.safeParse(value.images).data ?? [] }
        : {}),
      text: typeof value.text === 'string' ? value.text : '',
      ...(value.taskScope === 'review_only' ? { taskScope: 'review_only' as const } : {}),
      ...(value.verificationScope === 'release' ? { verificationScope: 'release' as const } : {}),
      ...(Array.isArray(value.attachments)
        ? { attachments: validTextAttachments(value.attachments) ? value.attachments : [] }
        : {}),
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
  if (
    !draft.text &&
    !draft.references.length &&
    !draft.attachments?.length &&
    !draft.images?.length &&
    !draft.permissionMode &&
    !draft.harness &&
    !draft.taskScope &&
    !draft.verificationScope
  )
    return null;
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
  const value = serializeComposerDraft(draft);
  const previous = revisions.get(sessionId);
  const revision = previous?.value === value ? previous.revision : (previous?.revision ?? 0) + 1;
  revisions.set(sessionId, { value, revision });
  try {
    if (value) window.localStorage.setItem(key(sessionId), value);
    else window.localStorage.removeItem(key(sessionId));
  } catch {
    // The draft remains usable in the current page when storage is unavailable.
  }
  return revision;
}

export function composerDraftRevision(sessionId: string) {
  return (
    revisions.get(sessionId)?.revision ??
    writeComposerDraft(sessionId, readComposerDraft(sessionId))
  );
}

export function isComposerCaptureCurrent(sessionId: string, revision: number) {
  return revision > (consumed.get(sessionId) ?? -1);
}

/** Completion may arrive in settings or in a new Composer; only consume the sent draft. */
export function clearSentComposerDraft(
  sessionId: string,
  revision: number,
  preserveAttachments = false,
  preserveImages = preserveAttachments,
) {
  consumed.set(sessionId, Math.max(consumed.get(sessionId) ?? -1, revision));
  const current = revisions.get(sessionId);
  if (current?.revision !== revision) return;
  try {
    if (window.localStorage.getItem(key(sessionId)) !== current.value) return;
  } catch {
    // Without storage the mounted Composer still owns its in-memory draft revision.
  }
  const previous = parseComposerDraft(current.value);
  writeComposerDraft(sessionId, {
    ...empty(),
    ...(preserveAttachments ? { attachments: previous.attachments } : {}),
    ...(preserveImages ? { images: previous.images } : {}),
  });
  window.dispatchEvent(
    new CustomEvent(COMPOSER_DRAFT_SENT, {
      detail: { sessionId, revision, preserveAttachments, preserveImages },
    }),
  );
}

/** The text of a draft (older callers and the new-session purpose). */
export function readDraft(sessionId: string) {
  return readComposerDraft(sessionId).text;
}

export function writeDraft(sessionId: string, text: string) {
  writeComposerDraft(sessionId, empty(text));
}
