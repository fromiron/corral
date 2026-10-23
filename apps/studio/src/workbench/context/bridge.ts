import {
  canonicalJson,
  ImageAttachment,
  ImageAttachments,
  type TextAttachment,
  textAttachmentKey,
} from '@corral/contracts';
import { validTextAttachments } from '@corral/core';
import {
  type ComposerDraft,
  composerDraftRevision,
  isComposerCaptureCurrent,
  readComposerDraft,
  writeComposerDraft,
} from '../sessionDraft.ts';

export interface ComposerTarget {
  hostId: string;
  projectId: string;
  sessionId: string;
}
export interface AttachmentCapture {
  target: ComposerTarget;
  revision: number;
}
export type AttachmentResult =
  | { ok: true }
  | { ok: false; reason: 'busy' | 'limit' | 'changed' | 'unavailable' };
export const COMPOSER_ATTACH = 'corral:composer-attach';
export interface AttachmentRequest {
  capture: AttachmentCapture;
  attachment: TextAttachment;
  image?: ImageAttachment;
  replaceKey?: string;
  result?: AttachmentResult;
}
export function beginAttachmentCapture(target: ComposerTarget): AttachmentCapture {
  return { target: { ...target }, revision: composerDraftRevision(target.sessionId) };
}
export function mergeComposerAttachment(
  value: TextAttachment[],
  request: AttachmentRequest,
): TextAttachment[] | AttachmentResult {
  if (!isComposerCaptureCurrent(request.capture.target.sessionId, request.capture.revision))
    return { ok: false, reason: 'changed' };
  if (!validTextAttachments([request.attachment])) return { ok: false, reason: 'unavailable' };
  const key = textAttachmentKey(request.attachment);
  const index = request.replaceKey
    ? value.findIndex((item) => textAttachmentKey(item) === request.replaceKey)
    : -1;
  if (request.replaceKey && index < 0) return { ok: false, reason: 'changed' };
  const next = request.replaceKey
    ? value.map((item, i) => (i === index ? request.attachment : item))
    : value.some((item) => textAttachmentKey(item) === key)
      ? value
      : [...value, request.attachment];
  return validTextAttachments(next) ? next : { ok: false, reason: 'limit' };
}
export function mergeComposerCapture(
  draft: ComposerDraft,
  request: AttachmentRequest,
): ComposerDraft | AttachmentResult {
  const attachments = mergeComposerAttachment(draft.attachments ?? [], request);
  if (!Array.isArray(attachments)) return attachments;
  if (request.image === undefined) return { ...draft, attachments };
  if (!ImageAttachment.safeParse(request.image).success)
    return { ok: false, reason: 'unavailable' };
  const images = draft.images?.some((image) => image.imageId === request.image?.imageId)
    ? draft.images
    : [...(draft.images ?? []), request.image];
  return ImageAttachments.safeParse(images).success
    ? { ...draft, attachments, images }
    : { ok: false, reason: 'limit' };
}
/** The mounted Composer owns current state; review routes fall back to its stored draft. */
export function appendComposerAttachment(
  capture: AttachmentCapture,
  attachment: TextAttachment,
  options?: { replaceKey?: string; image?: ImageAttachment },
): AttachmentResult {
  const request: AttachmentRequest = { capture, attachment, ...options };
  window.dispatchEvent(new CustomEvent(COMPOSER_ATTACH, { detail: request }));
  if (request.result) return request.result;
  const draft = readComposerDraft(capture.target.sessionId);
  const next = mergeComposerCapture(draft, request);
  if ('ok' in next) return next;
  writeComposerDraft(capture.target.sessionId, next);
  // Without a mounted Composer, successful storage is the handoff to the next view.
  return canonicalJson(readComposerDraft(capture.target.sessionId)) === canonicalJson(next)
    ? { ok: true }
    : { ok: false, reason: 'unavailable' };
}
