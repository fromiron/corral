import { z } from 'zod';
import { ContentHash } from './harness.ts';

export const WebSourceEvidence = z.strictObject({
  version: z.literal(1),
  sourceId: z.string().regex(/^src_[a-f0-9]{64}$/),
  originalUrl: z.url(),
  finalUrl: z.url(),
  fetchedAt: z.iso.datetime(),
  rawMime: z.enum(['text/plain', 'text/markdown', 'text/html']),
  rawHash: ContentHash,
  contentHash: ContentHash,
  rawBytes: z
    .int()
    .min(0)
    .max(1024 * 1024),
  requests: z.int().min(1).max(4),
  extractor: z.enum(['corral-text-1', 'corral-html-1/parse5-8.0.1']),
  publishedAt: z.iso.datetime().nullable(),
  modifiedAt: z.iso.datetime().nullable(),
  lastModified: z.iso.datetime().nullable(),
  trust: z.literal('untrusted'),
});
export type WebSourceEvidence = z.infer<typeof WebSourceEvidence>;
