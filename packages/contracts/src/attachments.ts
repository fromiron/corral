import { z } from 'zod';
import { canonicalJson } from './canonical-json.ts';
import { ContentHash } from './harness.ts';
import { Identifier } from './ids.ts';
import { WorkspaceTarget } from './workbench.ts';

/** Monaco lines and UTF-16 columns are 1-based; the end is exclusive. */
export const TextRange = z
  .strictObject({
    startLine: z.int().min(1),
    startColumn: z.int().min(1),
    endLine: z.int().min(1),
    endColumn: z.int().min(1),
  })
  .refine(
    (range) =>
      range.endLine > range.startLine ||
      (range.endLine === range.startLine && range.endColumn > range.startColumn),
    'selection end must follow its start',
  );
export type TextRange = z.infer<typeof TextRange>;

const SourcePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !/^([/\\]|[A-Za-z]:)/.test(path) &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      path
        .split('/')
        .every(
          (part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git',
        ) &&
      path.split('/')[0]?.toLowerCase() !== '.corral',
    'source path must be relative and normalized',
  );
const Tree = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const SnapshotSource = {
  hostId: WorkspaceTarget.shape.hostId,
  projectId: Identifier,
  sessionId: Identifier,
};
const TerminalRange = z
  .strictObject({
    startRow: z.int().min(0),
    startColumn: z.int().min(0),
    endRow: z.int().min(0),
    endColumn: z.int().min(0),
  })
  .refine(
    (range) =>
      range.endRow > range.startRow ||
      (range.endRow === range.startRow && range.endColumn > range.startColumn),
    'selection end must follow its start',
  );

/** Captured, user-supplied source metadata; never authority or proof of the current source. */
export const TextAttachmentProvenance = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('code'),
    target: WorkspaceTarget,
    path: SourcePath,
    snapshot: z.enum(['saved', 'draft']),
    baseHash: ContentHash.nullable(),
    bufferHash: ContentHash,
    editVersion: z.int().min(0),
    range: TextRange,
  }),
  z
    .strictObject({
      kind: z.literal('terminal'),
      target: WorkspaceTarget,
      terminalId: Identifier,
      generation: Identifier,
      outputSequence: z.int().min(0),
      buffer: z.enum(['normal', 'alternate']),
      cols: z.int().min(2).max(500),
      rows: z.int().min(1).max(500),
      range: TerminalRange,
    })
    .refine(
      (source) => source.range.startColumn <= source.cols && source.range.endColumn <= source.cols,
      'terminal selection columns exceed the captured width',
    ),
  z.strictObject({
    kind: z.literal('hunk'),
    ...SnapshotSource,
    from: Tree,
    to: Tree,
    path: SourcePath,
    patchHash: ContentHash,
    hunkIds: z
      .array(ContentHash)
      .min(1)
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length, 'duplicate hunk'),
  }),
  z.strictObject({
    kind: z.literal('check'),
    ...SnapshotSource,
    verificationId: Identifier,
    commandId: Identifier,
    tree: Tree,
    fingerprint: ContentHash.optional(),
    configRevision: z.int().min(1).optional(),
    // Raw report stream digest; TextAttachment.sha256 hashes the captured display text instead.
    outputHash: ContentHash.optional(),
    outputTruncated: z.boolean().optional(),
    range: TextRange.optional(),
  }),
]);
export type TextAttachmentProvenance = z.infer<typeof TextAttachmentProvenance>;

export const TEXT_ATTACHMENT_MAX_BYTES = 64 * 1024;
export const TEXT_ATTACHMENT_MAX_COUNT = 5;
export const TextAttachment = z.strictObject({
  kind: z.literal('text_attachment'),
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[^/\\\p{Cc}]+$/u),
  mime: z.enum(['text/plain', 'text/markdown', 'application/json', 'text/csv']),
  bytes: z.int().min(0).max(TEXT_ATTACHMENT_MAX_BYTES),
  sha256: ContentHash,
  provenance: TextAttachmentProvenance.optional(),
  text: z
    .string()
    .max(TEXT_ATTACHMENT_MAX_BYTES)
    .regex(/^[^\p{Cs}\0]*$/u),
});
export type TextAttachment = z.infer<typeof TextAttachment>;

export function textAttachmentKey(item: TextAttachment): string {
  return canonicalJson([item.name, item.sha256, item.provenance ?? null]);
}
export const TextAttachments = z
  .array(TextAttachment)
  .max(TEXT_ATTACHMENT_MAX_COUNT)
  .refine(
    (items) => new Set(items.map(textAttachmentKey)).size === items.length,
    'duplicate text attachment',
  );

export const IMAGE_MAX_BYTES = 1024 * 1024;
export const IMAGE_MAX_COUNT = 3;
export const ImageAttachment = z.strictObject({
  kind: z.literal('image_attachment'),
  imageId: Identifier,
  name: TextAttachment.shape.name,
  mime: z.literal('image/png'),
  bytes: z.int().min(1).max(IMAGE_MAX_BYTES),
  sha256: ContentHash,
  width: z.int().min(1).max(2048),
  height: z.int().min(1).max(2048),
});
export type ImageAttachment = z.infer<typeof ImageAttachment>;
export const ImageAttachments = z
  .array(ImageAttachment)
  .max(IMAGE_MAX_COUNT)
  .refine(
    (items) => new Set(items.map((item) => item.imageId)).size === items.length,
    'duplicate image attachment',
  );
export const ImageInput = ImageAttachment.extend({
  data: z
    .string()
    .min(1)
    .max(Math.ceil(IMAGE_MAX_BYTES / 3) * 4),
});
export type ImageInput = z.infer<typeof ImageInput>;
