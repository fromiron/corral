// @vitest-environment jsdom
import { IMAGE_MAX_COUNT, TEXT_ATTACHMENT_MAX_COUNT } from '@corral/contracts';
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
const image = {
  kind: 'image_attachment' as const,
  imageId: 'image_capture',
  name: 'capture.png',
  mime: 'image/png' as const,
  bytes: 1,
  sha256: 'a'.repeat(64),
  width: 1,
  height: 1,
};
it('merges a frozen capture into the latest draft without replacing later typing', () => {
  writeComposerDraft('capture_typing', draft('before'));
  const capture = beginAttachmentCapture(target('capture_typing'));
  writeComposerDraft('capture_typing', draft('later typing'));
  expect(appendComposerAttachment(capture, item)).toEqual({ ok: true });
  expect(readComposerDraft('capture_typing')).toMatchObject({
    text: 'later typing',
    attachments: [item],
  });
});
it('refuses a capture begun before the destination draft was sent', () => {
  const revision = writeComposerDraft('capture_sent', draft('send'));
  const capture = beginAttachmentCapture(target('capture_sent'));
  clearSentComposerDraft('capture_sent', revision);
  expect(appendComposerAttachment(capture, item, { image })).toEqual({
    ok: false,
    reason: 'changed',
  });
  expect(readComposerDraft('capture_sent').attachments).toBeUndefined();
  expect(readComposerDraft('capture_sent').images).toBeUndefined();
  expect(appendComposerAttachment(beginAttachmentCapture(target('capture_sent')), item)).toEqual({
    ok: true,
  });
});

it('adds captured text and uploaded image metadata together without replacing the draft', () => {
  const sessionId = 'capture_preview';
  const existing = createTextAttachment('existing.txt', 'text/plain', 'existing source');
  const existingImage = { ...image, imageId: 'existing_image' };
  writeComposerDraft(sessionId, {
    ...draft('Keep my request'),
    attachments: [existing],
    images: [existingImage],
  });
  const capture = beginAttachmentCapture(target(sessionId));
  expect(appendComposerAttachment(capture, item, { image })).toEqual({ ok: true });
  expect(readComposerDraft(sessionId)).toMatchObject({
    text: 'Keep my request',
    attachments: [existing, item],
    images: [existingImage, image],
  });
  expect(appendComposerAttachment(capture, item, { image })).toEqual({ ok: true });
  expect(readComposerDraft(sessionId).images).toEqual([existingImage, image]);
});

it.each([
  {
    name: 'text capacity',
    attachments: Array.from({ length: TEXT_ATTACHMENT_MAX_COUNT }, (_, index) =>
      createTextAttachment(`${index}.txt`, 'text/plain', `existing ${index}`),
    ),
    images: [],
    image,
    reason: 'limit',
  },
  {
    name: 'image capacity',
    attachments: [],
    images: Array.from({ length: IMAGE_MAX_COUNT }, (_, index) => ({
      ...image,
      imageId: `existing_${index}`,
    })),
    image,
    reason: 'limit',
  },
  {
    name: 'raw image bytes instead of metadata',
    attachments: [],
    images: [],
    image: { ...image, data: 'raw image bytes' },
    reason: 'unavailable',
  },
])('writes neither attachment when $name is rejected', (value) => {
  const sessionId = `capture_rejected_${value.name}`;
  const before = {
    ...draft('Keep my request'),
    attachments: value.attachments,
    images: value.images,
  };
  writeComposerDraft(sessionId, before);
  const capture = beginAttachmentCapture(target(sessionId));
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  try {
    expect(appendComposerAttachment(capture, item, { image: value.image })).toEqual({
      ok: false,
      reason: value.reason,
    });
    expect(storage).not.toHaveBeenCalled();
    expect(readComposerDraft(sessionId)).toEqual(before);
  } finally {
    storage.mockRestore();
  }
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

it('a review capture reports storage failure instead of navigating to a missing attachment', () => {
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

const replySource = {
  kind: 'reply' as const,
  runId: 'run_quoted',
  modelCallId: 'call_quoted',
  start: 4,
  end: 15,
  prefix: 'The ',
  suffix: ' fox',
};
const quote = createTextAttachment('quote.txt', 'text/plain', 'quick brown', replySource);
it('adds a reply quote to the latest draft through the same capture path', () => {
  writeComposerDraft('quote_typing', draft('before'));
  const capture = beginAttachmentCapture(target('quote_typing'));
  writeComposerDraft('quote_typing', draft('later typing'));
  expect(appendComposerAttachment(capture, quote)).toEqual({ ok: true });
  expect(readComposerDraft('quote_typing')).toMatchObject({
    text: 'later typing',
    attachments: [quote],
  });
});
it('refuses a reply quote captured before the destination draft was sent', () => {
  const revision = writeComposerDraft('quote_sent', draft('send'));
  const capture = beginAttachmentCapture(target('quote_sent'));
  clearSentComposerDraft('quote_sent', revision);
  expect(appendComposerAttachment(capture, quote)).toEqual({ ok: false, reason: 'changed' });
  expect(readComposerDraft('quote_sent').attachments).toBeUndefined();
});
it('keeps one chip for the same passage of the same reply, even when the text around it grew', () => {
  writeComposerDraft('quote_twice', draft(''));
  const capture = beginAttachmentCapture(target('quote_twice'));
  const grown = createTextAttachment('quote.txt', 'text/plain', 'quick brown', {
    ...replySource,
    suffix: ' fox jumps',
  });
  const other = createTextAttachment('quote.txt', 'text/plain', 'brown', {
    ...replySource,
    start: 10,
    prefix: 'The quick ',
  });
  for (const value of [quote, quote, grown, other])
    expect(appendComposerAttachment(capture, value)).toEqual({ ok: true });
  expect(readComposerDraft('quote_twice').attachments).toEqual([quote, other]);
});

// A later capture of the same passage whose words changed (a reply still streaming) replaces
// the chip in its place.
it('replaces the chip of the same passage when its text changed, keeping its place', () => {
  writeComposerDraft('quote_changed', draft(''));
  const capture = beginAttachmentCapture(target('quote_changed'));
  const other = createTextAttachment('quote.txt', 'text/plain', 'jumps', {
    ...replySource,
    start: 20,
    end: 25,
    prefix: 'The quick brown fox ',
    suffix: '',
  });
  const rewritten = createTextAttachment('quote.txt', 'text/plain', 'quick red', replySource);
  for (const value of [quote, other, rewritten])
    expect(appendComposerAttachment(capture, value)).toEqual({ ok: true });
  expect(readComposerDraft('quote_changed').attachments).toEqual([rewritten, other]);
});

it.each([
  ['runId', { runId: 'run_other' }],
  ['modelCallId', { modelCallId: 'call_other' }],
  ['start', { start: 5 }],
  ['end', { end: 14 }],
] as const)('a passage differing only in %s is another chip', (field, change) => {
  const sessionId = `quote_${field}`;
  writeComposerDraft(sessionId, draft(''));
  const capture = beginAttachmentCapture(target(sessionId));
  // The same words, so only the compared field tells the passages apart.
  const twin = createTextAttachment('quote.txt', 'text/plain', 'quick brown', {
    ...replySource,
    ...change,
  });
  expect(appendComposerAttachment(capture, quote)).toEqual({ ok: true });
  expect(appendComposerAttachment(capture, twin)).toEqual({ ok: true });
  expect(readComposerDraft(sessionId).attachments).toEqual([quote, twin]);
});
