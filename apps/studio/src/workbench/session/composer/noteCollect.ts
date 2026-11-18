// A browser annotation collected into the draft (features/browser-annotate.md 모아 두기, 계약: 첨부):
// "담기" adds the note's attachment `annotation-{n}.json` and its screenshot to the composer's
// draft together or not at all, one add at a time. Its limits are the composer's; a draft sent
// while it uploads, or an add the overlay stopped waiting for, adds nothing. The note's pick is
// remembered in this page alone, for the marker on its element.
import {
  type AnnotationMaterial,
  IMAGE_MAX_COUNT,
  type ImageAttachment,
  TEXT_ATTACHMENT_MAX_COUNT,
  textAttachmentKey,
} from '@corral/contracts';
import { useRef, useState } from 'react';
import type { AnnotateOutcome } from '../../../annotate/protocol.ts';
import type { StudioServices } from '../../../services.tsx';
import { noteAttachment, pageProvenance } from '../../browser/noteAttachment.ts';
import { nextNoteNumber } from '../../browser/noteChips.ts';
import { appendComposerAttachment, beginAttachmentCapture } from '../../context/bridge.ts';
import { readComposerDraft } from '../../sessionDraft.ts';
import { previewProvenance, uploadScreenshot } from './noteSend.ts';

export interface NoteAddRequest {
  noteId: string;
  material: AnnotationMaterial;
  /** Aborted when the overlay stops waiting: the upload stops and nothing is added. */
  signal: AbortSignal;
}

export interface NoteCollectDeps {
  services: StudioServices;
  sessionId: string;
  projectId: string;
  /** Sentences: the draft's limits, and a screenshot the server did not take. */
  attachmentsFull: string;
  imagesFull: string;
  imageFailed: string;
  imageLimit: string;
}

export function createNoteCollector(read: () => NoteCollectDeps) {
  /** The pick of each collected note, by its attachment: this page's markers. */
  const picks = new Map<string, string>();
  let picksFor = read().sessionId;
  const picksNow = () => {
    const { sessionId } = read();
    if (picksFor !== sessionId) {
      picksFor = sessionId;
      picks.clear();
    }
    return picks;
  };
  let queue: Promise<unknown> = Promise.resolve();

  const add = async ({ material, signal }: NoteAddRequest): Promise<AnnotateOutcome> => {
    const now = read();
    const notAdded = (reason: string | null = null): AnnotateOutcome => ({
      kind: 'not-added',
      reason,
    });
    const hostId = now.services.workspaceId;
    if (!hostId || signal.aborted) return notAdded();
    // A draft sent from here on is not the draft this note goes into.
    const capture = beginAttachmentCapture({
      hostId,
      projectId: now.projectId,
      sessionId: now.sessionId,
    });
    const draft = readComposerDraft(now.sessionId);
    if ((draft.attachments?.length ?? 0) >= TEXT_ATTACHMENT_MAX_COUNT)
      return notAdded(now.attachmentsFull);
    if (material.screenshot && (draft.images?.length ?? 0) >= IMAGE_MAX_COUNT)
      return notAdded(now.imagesFull);
    const n = nextNoteNumber(draft.attachments ?? []);
    // The screenshot is left out only when the person turned it off.
    let image: ImageAttachment | undefined;
    if (material.screenshot) {
      const uploaded = await uploadScreenshot(
        now,
        material.screenshot,
        `annotation-${n}.png`,
        signal,
      );
      if (signal.aborted) return notAdded();
      if ('refused' in uploaded) return notAdded(uploaded.refused);
      image = uploaded;
    }
    const provenance =
      pageProvenance(material, image?.sha256) ??
      (await previewProvenance(now, material, image?.sha256));
    if (signal.aborted || !provenance) return notAdded();
    let attachment: ReturnType<typeof noteAttachment>;
    try {
      attachment = noteAttachment(material, `annotation-${n}.json`, provenance);
    } catch {
      return notAdded(now.attachmentsFull);
    }
    const result = appendComposerAttachment(capture, attachment, {
      ...(image ? { image } : {}),
      quiet: true,
    });
    if (!result.ok)
      return result.reason === 'limit'
        ? notAdded(image ? now.imagesFull : now.attachmentsFull)
        : notAdded();
    // Added only when the draft holds it now.
    const key = textAttachmentKey(attachment);
    const held = readComposerDraft(now.sessionId).attachments?.some(
      (item) => textAttachmentKey(item) === key,
    );
    if (!held) return notAdded();
    picksNow().set(key, material.pickId);
    return { kind: 'added', n };
  };

  return {
    /** One add at a time: the next one numbers itself after the last has landed. */
    addNote(request: NoteAddRequest): Promise<AnnotateOutcome> {
      const next = queue.then(() => add(request));
      queue = next.catch(() => {});
      return next;
    },
    /** The pick a collected note was made from, while this page remembers it. */
    pickOf: (key: string) => picksNow().get(key) ?? null,
  };
}

export function useNoteCollector(deps: NoteCollectDeps) {
  const latest = useRef(deps);
  latest.current = deps;
  const [collector] = useState(() => createNoteCollector(() => latest.current));
  return collector;
}
