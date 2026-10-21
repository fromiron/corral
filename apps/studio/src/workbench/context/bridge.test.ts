// @vitest-environment jsdom
import { createTextAttachment } from '@corral/core';
import { expect, it, vi } from 'vitest';
import { clearSentComposerDraft, readComposerDraft, writeComposerDraft } from '../sessionDraft.ts';
import { appendComposerAttachment, beginAttachmentCapture } from './bridge.ts';

const target = (sessionId: string) => ({ hostId: 'host', projectId: 'project', sessionId });
const draft = (text: string) => ({
  text,
  intent: null,
  target: null,
  targetLabel: null,
  references: [],
});
const item = createTextAttachment('selection.txt', 'text/plain', 'captured code');
it('[TC-WBD-007-H] merges a frozen capture into the latest draft without replacing later typing', () => {
  writeComposerDraft('capture_typing', draft('before'));
  const capture = beginAttachmentCapture(target('capture_typing'));
  writeComposerDraft('capture_typing', draft('later typing'));
  expect(appendComposerAttachment(capture, item)).toEqual({ ok: true });
  expect(readComposerDraft('capture_typing')).toMatchObject({
    text: 'later typing',
    attachments: [item],
  });
});
it('[TC-WBD-007-F] refuses a capture begun before the destination draft was sent', () => {
  const revision = writeComposerDraft('capture_sent', draft('send'));
  const capture = beginAttachmentCapture(target('capture_sent'));
  clearSentComposerDraft('capture_sent', revision);
  expect(appendComposerAttachment(capture, item)).toEqual({ ok: false, reason: 'changed' });
  expect(readComposerDraft('capture_sent').attachments).toBeUndefined();
  expect(appendComposerAttachment(beginAttachmentCapture(target('capture_sent')), item)).toEqual({
    ok: true,
  });
});
it('queue consumption clears text attachments but retains next-only images', () => {
  const image = {
    kind: 'image_attachment' as const,
    imageId: 'image_1',
    name: 'a.png',
    mime: 'image/png' as const,
    bytes: 1,
    sha256: 'a'.repeat(64),
    width: 1,
    height: 1,
  };
  const revision = writeComposerDraft('capture_queue', {
    ...draft('queue'),
    attachments: [item],
    images: [image],
  });
  clearSentComposerDraft('capture_queue', revision, false, true);
  expect(readComposerDraft('capture_queue')).toMatchObject({ text: '', images: [image] });
  expect(readComposerDraft('capture_queue').attachments).toBeUndefined();
});

it('[TC-WBD-007-F] a review capture reports storage failure instead of navigating to a missing attachment', () => {
  writeComposerDraft('capture_storage', draft('keep this'));
  const capture = beginAttachmentCapture(target('capture_storage'));
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError');
  });
  try {
    expect(appendComposerAttachment(capture, item)).toEqual({ ok: false, reason: 'unavailable' });
    expect(readComposerDraft('capture_storage')).toMatchObject({ text: 'keep this' });
    expect(readComposerDraft('capture_storage').attachments).toBeUndefined();
  } finally {
    storage.mockRestore();
  }
});
