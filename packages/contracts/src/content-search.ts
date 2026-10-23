import { z } from 'zod';
import { TextRange } from './attachments.ts';
import { ContentHash, ResourcePath } from './harness.ts';
import { Identifier } from './ids.ts';
import { WorkspaceTarget } from './workbench.ts';

export const ContentSearch = z.strictObject({
  target: WorkspaceTarget,
  queryId: Identifier,
  query: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => !/[\r\n\0]/.test(value), 'search one line at a time'),
  caseSensitive: z.boolean().default(false),
});
export type ContentSearch = z.infer<typeof ContentSearch>;
export const ContentSearchMatch = z.strictObject({
  path: ResourcePath,
  sha256: ContentHash,
  range: TextRange,
  preview: z.string().max(400),
});
export type ContentSearchMatch = z.infer<typeof ContentSearchMatch>;
export interface ContentSearchResult {
  target: WorkspaceTarget;
  queryId: string;
  query: string;
  caseSensitive: boolean;
  matches: ContentSearchMatch[];
  scannedFiles: number;
  skippedFiles: number;
  truncated: boolean;
}
