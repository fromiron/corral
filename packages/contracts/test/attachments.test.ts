import { expect, it } from 'vitest';
import {
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

it('[TC-WBD-007-H] uses actual code/terminal and read-only hunk/check identities without inventing a copy generation', () => {
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

it('[TC-WBD-007-N] refuses reversed ranges, traversal, invalid snapshot hashes and fabricated authority fields', () => {
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
