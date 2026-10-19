import { z } from 'zod';
import { ContentHash } from './harness.ts';
import { Identifier } from './ids.ts';

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
  text: z
    .string()
    .max(TEXT_ATTACHMENT_MAX_BYTES)
    .regex(/^[^\p{Cs}\0]*$/u),
});
export type TextAttachment = z.infer<typeof TextAttachment>;
export const TextAttachments = z
  .array(TextAttachment)
  .max(TEXT_ATTACHMENT_MAX_COUNT)
  .refine(
    (items) => new Set(items.map((item) => `${item.name}:${item.sha256}`)).size === items.length,
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
