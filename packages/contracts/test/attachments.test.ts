import { expect, it } from 'vitest';
import {
  TextAttachment,
  TextAttachmentProvenance,
  TextAttachments,
  textAttachmentKey,
} from '../src/attachments.ts';

const snapshot = { hostId: 'host', projectId: 'project', sessionId: 'session' };
const target = { ...snapshot, bindingId: 'binding', copyGeneration: 1 };
const digest = 'a'.repeat(64);
const code = {
  kind: 'code' as const,
  target,
  path: 'src/a.ts',
  snapshot: 'draft' as const,
  baseHash: null,
  bufferHash: digest,
  editVersion: 1,
  range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 },
};
const terminal = {
  kind: 'terminal' as const,
  target,
  terminalId: 'terminal_1',
  generation: 'generation_1',
  outputSequence: 0,
  buffer: 'normal' as const,
  cols: 80,
  rows: 24,
  range: { startRow: 0, startColumn: 0, endRow: 0, endColumn: 3 },
};
const hunk = {
  kind: 'hunk' as const,
  ...snapshot,
  from: 'a'.repeat(40),
  to: 'b'.repeat(40),
  path: 'a.ts',
  patchHash: digest,
  hunkIds: [digest],
};
const check = {
  kind: 'check' as const,
  ...snapshot,
  verificationId: 'verification_1',
  commandId: 'check_1',
  tree: 'a'.repeat(40),
};
const attachment = {
  kind: 'text_attachment' as const,
  name: 'selection.txt',
  mime: 'text/plain' as const,
  bytes: 3,
  sha256: digest,
  text: 'one',
};

it('uses actual code/terminal and read-only hunk/check identities without inventing a copy generation', () => {
  for (const provenance of [code, terminal, hunk, check])
    expect(TextAttachmentProvenance.parse(provenance)).toEqual(provenance);
  const other = { ...attachment, provenance: { ...code, path: 'src/b.ts' } };
  expect(TextAttachments.safeParse([{ ...attachment, provenance: code }, other]).success).toBe(
    true,
  );
  expect(textAttachmentKey({ ...attachment, provenance: code })).not.toBe(textAttachmentKey(other));
  expect(TextAttachments.safeParse([attachment, { ...attachment }]).success).toBe(false);
  expect(
    TextAttachments.safeParse([
      { ...attachment, provenance: code },
      { ...attachment, provenance: code },
    ]).success,
  ).toBe(false);
});

it('refuses reversed ranges, traversal, invalid snapshot hashes and fabricated authority fields', () => {
  for (const provenance of [
    { ...code, range: { ...code.range, startColumn: 5 } },
    { ...code, path: '../a.ts' },
    { ...code, bufferHash: 'not-a-hash' },
    { ...terminal, range: { ...terminal.range, startRow: -1 } },
    { ...terminal, range: { ...terminal.range, endColumn: 81 } },
    { ...hunk, hunkIds: [digest, digest] },
    { ...check, copyGeneration: 1 },
    { ...check, verifiedByServer: true },
  ])
    expect(TextAttachmentProvenance.safeParse(provenance).success).toBe(false);
});

it('retains preview identity without claiming a source revision or carrying authentication', () => {
  const source = {
    kind: 'preview',
    target,
    leaseId: 'preview_one',
    operationId: 'task_one',
    url: 'http://127.0.0.2:4321/page',
    capturedAt: '2026-10-23T12:00:00.000Z',
    pageRevision: 2,
    sourceRevision: null,
    screenshotHash: digest,
  };
  expect(TextAttachmentProvenance.safeParse(source).success).toBe(true);
  for (const extra of [
    { sourceRevision: digest },
    { headers: { authorization: 'not-allowed' } },
    { url: 'http://user:password@127.0.0.2:4321/page' },
    { url: 'http://127.0.0.2:4321/page?token=private' },
    { url: 'http://127.0.0.1:4317/api/v1/session' },
  ])
    expect(TextAttachmentProvenance.safeParse({ ...source, ...extra }).success).toBe(false);
});

const reply = {
  kind: 'reply' as const,
  runId: 'run_1',
  modelCallId: 'call_1',
  start: 4,
  end: 9,
  prefix: 'The ',
  suffix: ' runs',
};
const quoted = (text: string, provenance: unknown = reply) => ({
  ...attachment,
  name: 'quote.txt',
  bytes: text.length,
  text,
  ...(provenance === null ? {} : { provenance }),
});

it('accepts a reply quote with its run, model call, UTF-16 offsets and surrounding text', () => {
  expect(TextAttachmentProvenance.parse(reply)).toEqual(reply);
  expect(
    TextAttachmentProvenance.safeParse({ ...reply, start: 0, prefix: '', suffix: '' }).success,
  ).toBe(true);
  expect(TextAttachment.safeParse(quoted('quick')).success).toBe(true);
});

it('bounds a reply quote: offsets, surrounding text and the quoted body', () => {
  const p32 = 'p'.repeat(32);
  expect(TextAttachmentProvenance.safeParse({ ...reply, prefix: p32, suffix: p32 }).success).toBe(
    true,
  );
  for (const provenance of [
    { ...reply, prefix: 'p'.repeat(33) },
    { ...reply, suffix: 's'.repeat(33) },
    { ...reply, end: reply.start },
    { ...reply, end: reply.start - 1 },
    { ...reply, start: -1 },
    { ...reply, start: 1.5 },
    { ...reply, end: 9.5 },
    { ...reply, runId: '' },
    { ...reply, verifiedByServer: true },
    { ...reply, note: 'extra' },
  ])
    expect(TextAttachmentProvenance.safeParse(provenance).success).toBe(false);
  expect(TextAttachment.safeParse(quoted('q'.repeat(8_000))).success).toBe(true);
  expect(TextAttachment.safeParse(quoted('q'.repeat(8_001))).success).toBe(false);
  expect(TextAttachment.safeParse(quoted('')).success).toBe(false);
  // The other sources keep their own rules: an empty or long body is not a reply quote.
  expect(TextAttachment.safeParse(quoted('', null)).success).toBe(true);
  expect(TextAttachment.safeParse(quoted('q'.repeat(8_001), check)).success).toBe(true);
});
