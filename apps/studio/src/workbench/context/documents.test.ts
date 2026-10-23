import { createHash } from 'node:crypto';
import { TEXT_ATTACHMENT_MAX_BYTES } from '@corral/contracts';
import { expect, it } from 'vitest';
import type { DocumentBuffer } from '../documents/store.ts';
import { captureDocumentAttachment, hashDocumentText } from './documents.ts';

function document(text: string): DocumentBuffer {
  const target = {
    hostId: 'host',
    projectId: 'project',
    bindingId: 'binding',
    sessionId: 'session',
    copyGeneration: 2,
  };
  return {
    key: 'document',
    target,
    path: 'src/example.ts',
    text,
    baseText: text,
    baseHash: 'a'.repeat(64),
    file: {
      target,
      path: 'src/example.ts',
      content: { kind: 'text', text },
      version: null,
      writable: true,
    },
    model: null,
    editVersion: 4,
    dirty: false,
    saving: false,
    pendingSave: null,
    canRetrySave: false,
    conflict: null,
    formatBlocked: false,
    recoveries: [],
    otherRecoveries: [],
    recoverySavedVersion: null,
    recoveryError: null,
    modelError: null,
    error: null,
  };
}

it('[TC-WBD-007-H] captures only the UTF-16 selection and hashes the full BOM-preserving buffer', async () => {
  const text = '\uFEFFbefore😀\r\nchosen한글\r\nhidden';
  const entry = document(text);
  const range = { startLine: 1, startColumn: 7, endLine: 2, endColumn: 9 };
  const attachment = await captureDocumentAttachment(entry, range);
  expect(attachment.text).toBe('😀\r\nchosen한글');
  expect(attachment.provenance).toEqual({
    kind: 'code',
    target: entry.target,
    path: entry.path,
    snapshot: 'saved',
    baseHash: entry.baseHash,
    bufferHash: createHash('sha256').update(text).digest('hex'),
    editVersion: 4,
    range,
  });
  expect(await hashDocumentText(text)).not.toBe(attachment.sha256);
});

it('[TC-WBD-007-N] the captured draft and version cannot change while the asynchronous hash finishes', async () => {
  const entry = document('captured\nother');
  entry.dirty = true;
  const capture = captureDocumentAttachment(entry, {
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 9,
  });
  entry.text = 'later edit';
  entry.editVersion = 5;
  entry.target.copyGeneration = 3;
  const attachment = await capture;
  expect(attachment.text).toBe('captured');
  expect(attachment.provenance).toMatchObject({
    snapshot: 'draft',
    editVersion: 4,
    target: { copyGeneration: 2 },
  });
});

it('[TC-WBD-007-F] an invalid or oversized selection is refused without truncating it', async () => {
  await expect(
    captureDocumentAttachment(document('short'), {
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 10,
    }),
  ).rejects.toThrow();
  const text = 'x'.repeat(TEXT_ATTACHMENT_MAX_BYTES + 1);
  await expect(
    captureDocumentAttachment(document(text), {
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: text.length + 1,
    }),
  ).rejects.toThrow();
});
