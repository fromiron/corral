import type { RunReference, TextAttachment } from '@corral/contracts';
import {
  type ImageAttachment,
  ImageAttachments,
  PermissionMode,
  RunReferences,
} from '@corral/contracts';
import type { CorralSummary, RunSummary, SessionEntry, WorkSession } from '@corral/core';
import { validTextAttachments } from '@corral/core';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../../../services.tsx';
import type { IntentLock, SendChoice } from '../../composerIntent.ts';
import {
  type MentionItem,
  type MentionNames,
  mentionToken,
  pickedReferences,
  restoredMentions,
} from '../../composerMenu.ts';
import {
  type AttachmentRequest,
  COMPOSER_ATTACH,
  mergeComposerCapture,
} from '../../context/bridge.ts';
import type { FileReference } from '../../FilePanel.tsx';
import { EDIT_REQUEST } from '../../RefusalHelp.tsx';
import { COMPOSER_DRAFT_SENT, type ComposerDraft, writeComposerDraft } from '../../sessionDraft.ts';

// The composer's draft: its text, intent lock, references and attachments, kept in the
// session's stored draft and filled by captures, "edit the request again" and a sent draft.

/** What a request brings back into the box: the same from every way back. */
export type TakenBackRequest = Pick<
  SessionEntry,
  'text' | 'permissionMode' | 'attachments' | 'images' | 'references'
>;

/** References a request may bring back: none of its attachments, and a valid start list. */
const validReferences = (value: unknown): value is RunReference[] =>
  Array.isArray(value) &&
  value.every(
    (reference) => reference?.kind !== 'text_attachment' && reference?.kind !== 'image_attachment',
  ) &&
  RunReferences.safeParse(value).success;

export function useComposerDraft({
  session,
  team,
  runs = [],
  restored,
  busy,
  input,
  targetLabel,
  onEditRequest,
}: {
  session: WorkSession;
  team: CorralSummary | null;
  /** The session's runs in list order; a run's `@` name is its number among them. */
  runs?: readonly RunSummary[];
  /** The stored draft read when the composer mounted. */
  restored: ComposerDraft;
  busy: boolean;
  input: RefObject<HTMLTextAreaElement | null>;
  targetLabel: (id: string) => string | null;
  /** A refused turn's text came back to be edited. */
  onEditRequest: () => void;
}) {
  const services = useServices();
  const { repository, transport } = services;
  const [text, setText] = useState(restored.text);
  const [permissionMode, setPermissionMode] = useState<PermissionMode | undefined>(
    restored.permissionMode,
  );
  const [attachments, setAttachments] = useState<TextAttachment[]>(restored.attachments ?? []);
  const [attachmentsBusy, setAttachmentsBusy] = useState(false);
  const [images, setImages] = useState<ImageAttachment[]>(restored.images ?? []);
  const [imagesBusy, setImagesBusy] = useState(false);
  const [attachmentEpoch, setAttachmentEpoch] = useState(0);
  // A send picked for the next send only.
  const [chosen, setChosen] = useState<SendChoice | null>(null);
  // UX-01: a picked target is fixed once typing starts; a next request is not.
  const [lock, setLock] = useState<IntentLock | null>(
    restored.text && restored.intent === 'steer'
      ? { intent: 'steer', target: restored.target }
      : null,
  );
  const [picked, setPicked] = useState<MentionItem[]>(restored.references);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const tw = useTranslations('Workbench');
  // The team's role names, as the `@` menu names roles; null while they are read.
  const [roleNames, setRoleNames] = useState<Map<string, string> | null>(team ? null : new Map());
  const teamKey = team ? `${team.corralId}:${team.definitionRevision}` : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: the team is read again when its key changes
  useEffect(() => {
    if (!team) {
      setRoleNames(new Map());
      return;
    }
    let live = true;
    setRoleNames(null);
    void repository.get(team.corralId).then(
      (record) => {
        if (live)
          setRoleNames(new Map(record?.definition.roles.map((role) => [role.id, role.name]) ?? []));
      },
      () => {
        if (live) setRoleNames(new Map());
      },
    );
    return () => {
      live = false;
    };
  }, [teamKey]);
  const names: MentionNames = {
    run: (runId) => {
      const number = runs.findIndex((run) => run.runId === runId) + 1;
      return number ? tw('runNumber', { number }) : null;
    },
    role: (roleId) => roleNames?.get(roleId) ?? null,
  };
  // Chips of a request taken back before the role names were read, bound once they are.
  const waitingChips = useRef<{ text: string; references: RunReference[] } | null>(null);
  const restoreChips = (value: string, references: RunReference[]) => {
    const items = restoredMentions(value, references, names);
    setPicked(items);
    waitingChips.current =
      roleNames === null && references.some((reference) => reference.kind === 'role')
        ? { text: value, references }
        : null;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: bound again only when the names arrive
  useEffect(() => {
    const waiting = waitingChips.current;
    if (!roleNames || !waiting) return;
    waitingChips.current = null;
    const items = restoredMentions(waiting.text, waiting.references, names);
    setPicked((list) => [...items, ...list.filter((item) => !items.some((x) => x.id === item.id))]);
  }, [roleNames]);

  /** A new set of attachment pickers: nothing is loading any more. */
  const resetAttachments = () => {
    setAttachmentEpoch((epoch) => epoch + 1);
    setAttachmentsBusy(false);
    setImagesBusy(false);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: the label is read when the lock changes
  const composerDraft = useMemo(
    () => ({
      text,
      intent: lock?.intent ?? null,
      target: lock?.target ?? null,
      targetLabel: lock?.target ? targetLabel(lock.target) : null,
      references: picked.filter((item) => pickedReferences(text, [item]).length > 0),
      ...(attachments.length ? { attachments } : {}),
      ...(images.length ? { images } : {}),
      ...(permissionMode ? { permissionMode } : {}),
    }),
    [text, lock, picked, attachments, images, permissionMode],
  );
  const draftRevision = useRef(0);
  const currentDraft = useRef({ draft: composerDraft, busy: false });
  currentDraft.current = {
    draft: composerDraft,
    busy: busy || attachmentsBusy || imagesBusy,
  };
  useEffect(() => {
    const attach = (event: Event) => {
      const request = (event as CustomEvent<AttachmentRequest>).detail;
      const destination = request.capture.target;
      if (
        destination.hostId !== services.workspaceId ||
        destination.projectId !== session.projectId ||
        destination.sessionId !== session.sessionId
      )
        return;
      if (currentDraft.current.busy) {
        request.result = { ok: false, reason: 'busy' };
        return;
      }
      const draft = mergeComposerCapture(currentDraft.current.draft, request);
      if ('ok' in draft) {
        request.result = draft;
        return;
      }
      currentDraft.current.draft = draft;
      draftRevision.current = writeComposerDraft(session.sessionId, draft);
      setAttachments(draft.attachments ?? []);
      if (request.image !== undefined) setImages(draft.images ?? []);
      request.result = { ok: true };
      requestAnimationFrame(() => input.current?.focus());
    };
    window.addEventListener(COMPOSER_ATTACH, attach);
    return () => window.removeEventListener(COMPOSER_ATTACH, attach);
  }, [services.workspaceId, session.projectId, session.sessionId, input]);
  useEffect(() => {
    draftRevision.current = writeComposerDraft(session.sessionId, composerDraft);
  }, [session.sessionId, composerDraft]);
  useEffect(() => {
    const sent = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          sessionId: string;
          revision: number;
          preserveAttachments?: boolean;
          preserveImages?: boolean;
        }>
      ).detail;
      if (detail.sessionId !== session.sessionId || detail.revision !== draftRevision.current)
        return;
      setPicked([]);
      if (!detail.preserveAttachments) setAttachments([]);
      if (!detail.preserveImages) setImages([]);
      setAttachmentEpoch((epoch) => epoch + 1);
      setAttachmentsBusy(false);
      setImagesBusy(false);
      setPermissionMode(undefined);
      setChosen(null);
      setLock(null);
      setText('');
    };
    window.addEventListener(COMPOSER_DRAFT_SENT, sent);
    return () => window.removeEventListener(COMPOSER_DRAFT_SENT, sent);
  }, [session.sessionId]);

  // References restored from a draft are checked once: a result version, run or role that is
  // gone is marked, never swapped for another with the same name.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the restored references
  useEffect(() => {
    if (!restored.references.length) return;
    let live = true;
    void (async () => {
      const gone = new Set<string>();
      const roles = team
        ? ((await repository.get(team.corralId))?.definition.roles.map((r) => r.id) ?? [])
        : [];
      for (const item of restored.references) {
        const ref = item.reference;
        try {
          if (ref.kind === 'result') {
            const { projection } = await transport.getSnapshot(ref.runId);
            if (!projection.artifacts[ref.artifactVersionId]) gone.add(item.id);
          } else if (ref.kind === 'run') await transport.getSnapshot(ref.runId);
          else if (ref.kind === 'role' && !roles.includes(ref.roleId)) gone.add(item.id);
        } catch {
          gone.add(item.id);
        }
      }
      if (live) setMissing(gone);
    })();
    return () => {
      live = false;
    };
  }, []);

  // "Edit the request again" on a refused turn brings its text back here.
  const editRequested = useRef(onEditRequest);
  editRequested.current = onEditRequest;
  useEffect(() => {
    const take = (event: Event) => {
      const value = (event as CustomEvent<string | TakenBackRequest>).detail;
      if (
        typeof value !== 'string' &&
        (typeof value !== 'object' ||
          !value ||
          typeof value.text !== 'string' ||
          (value.permissionMode !== undefined &&
            !PermissionMode.safeParse(value.permissionMode).success) ||
          (value.attachments !== undefined && !validTextAttachments(value.attachments)) ||
          (value.images !== undefined && !ImageAttachments.safeParse(value.images).success) ||
          (value.references !== undefined && !validReferences(value.references)))
      )
        return;
      const request = typeof value === 'string' ? { text: value } : value;
      setAttachmentEpoch((epoch) => epoch + 1);
      setAttachmentsBusy(false);
      setImagesBusy(false);
      setText(request.text);
      restoreItems.current(request);
      setLock(null);
      editRequested.current();
      requestAnimationFrame(() => input.current?.focus());
    };
    window.addEventListener(EDIT_REQUEST, take);
    return () => window.removeEventListener(EDIT_REQUEST, take);
  }, [input]);

  /** Writes the draft as it is sent; its revision tells the sent draft apart from a newer one. */
  const submit = () => {
    const revision = writeComposerDraft(session.sessionId, composerDraft);
    draftRevision.current = revision;
    return revision;
  };

  /**
   * What every way back into the box brings with the text (features/composer-flow.md "대기
   * 요청과 넘겨받기"): its permission mode, text attachments, images, and its references as chips
   * on their own tokens. The text itself is written by the caller.
   */
  const restore = (request: TakenBackRequest) => {
    setPermissionMode(request.permissionMode);
    setAttachments(request.attachments ?? []);
    setImages(request.images ?? []);
    restoreChips(request.text, request.references ?? []);
  };
  const restoreItems = useRef(restore);
  restoreItems.current = restore;

  /** Editing a queued task takes it back into the box; sending again records a new version. */
  const takeBack = (entry: SessionEntry) => {
    resetAttachments();
    setText(entry.text);
    restore(entry);
    // Sent again, it is a next request: it waits while a run is going, else it starts. The send
    // key sends it as one, never as a join that would drop its permission mode and images.
    setChosen('queue');
    setLock(null);
  };

  // The references the text still names, each once; a gone one stops sending.
  const references = pickedReferences(text, picked);
  const chips = picked.filter(
    (item, index) =>
      picked.findIndex((x) => x.id === item.id) === index &&
      pickedReferences(text, [item]).length > 0,
  );
  const missingChips = chips.filter((item) => missing.has(item.id));

  return {
    takeBack,
    restore,
    references,
    chips,
    missingChips,
    text,
    setText,
    permissionMode,
    setPermissionMode,
    attachments,
    setAttachments,
    attachmentsBusy,
    setAttachmentsBusy,
    images,
    setImages,
    imagesBusy,
    setImagesBusy,
    attachmentEpoch,
    resetAttachments,
    chosen,
    setChosen,
    lock,
    setLock,
    picked,
    setPicked,
    missing,
    submit,
  };
}

export type ComposerDraftState = ReturnType<typeof useComposerDraft>;

/** A line range chosen in the file panel arrives as a reference at the caret. */
export function useFileReference({
  reference,
  input,
  text,
  write,
  setPicked,
  onReferenceUsed,
}: {
  reference: FileReference | null;
  input: RefObject<HTMLTextAreaElement | null>;
  text: string;
  write: (value: string) => void;
  setPicked: (update: (list: MentionItem[]) => MentionItem[]) => void;
  onReferenceUsed: () => void;
}) {
  const used = useRef<FileReference | null>(null);
  useEffect(() => {
    if (!reference || used.current === reference) return;
    used.current = reference;
    const item: MentionItem = {
      id: `file:${reference.path}:${reference.start}-${reference.end}`,
      kind: 'file',
      label: reference.path,
      lines: { start: reference.start, end: reference.end },
      reference: {
        kind: 'file',
        path: reference.path,
        lines: { start: reference.start, end: reference.end },
      },
    };
    setPicked((list) => [...list, item]);
    const box = input.current;
    const at = box?.selectionStart ?? text.length;
    const before = text.slice(0, at);
    const token = mentionToken(item);
    const next = `${before}${before && !/\s$/.test(before) ? ' ' : ''}${token} ${text.slice(at)}`;
    write(next);
    onReferenceUsed();
    requestAnimationFrame(() => box?.focus());
  });
}
