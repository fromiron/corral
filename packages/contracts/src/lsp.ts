import { z } from 'zod';
import { ContentHash, type EffectiveHarnessSnapshot, ResourcePath } from './harness.ts';
import { Identifier } from './ids.ts';

export const LspPosition = z.strictObject({
  line: z.int().min(0).max(2147483647),
  character: z.int().min(0).max(2147483647),
});
export const LspRange = z
  .strictObject({ start: LspPosition, end: LspPosition })
  .refine(
    (range) =>
      range.end.line > range.start.line ||
      (range.end.line === range.start.line && range.end.character >= range.start.character),
    'range is reversed',
  );
const QueryHead = {
  serverId: Identifier,
  path: ResourcePath,
  languageId: z.string().max(60).optional(),
};
export const LspQuery = z.discriminatedUnion('operation', [
  z.strictObject({ ...QueryHead, operation: z.literal('diagnostics') }),
  z.strictObject({
    ...QueryHead,
    operation: z.enum(['definition', 'references']),
    position: LspPosition,
  }),
]);
export type LspQuery = z.infer<typeof LspQuery>;
export interface LspExecution {
  runId: string;
  executionId: string;
  attemptNo: number;
  effectId: string;
  selection: NonNullable<EffectiveHarnessSnapshot['projectTools']>;
  query: LspQuery;
}
export const LspLocation = z.strictObject({
  path: ResourcePath,
  sha256: ContentHash,
  range: LspRange,
});
export const LspDiagnostic = z.strictObject({
  range: LspRange,
  message: z.string().max(4000),
  severity: z.int().min(1).max(4).optional(),
  code: z.union([z.string().max(200), z.number()]).optional(),
  source: z.string().max(200).optional(),
});
export const LspReport = z.strictObject({
  serverId: Identifier,
  operation: z.enum(['diagnostics', 'definition', 'references']),
  configRevision: z.int().min(1),
  fingerprint: ContentHash,
  tree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  source: z.strictObject({ path: ResourcePath, sha256: ContentHash, version: z.literal(1) }),
  result: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('locations'), locations: z.array(LspLocation).max(256) }),
    z.strictObject({
      kind: z.literal('diagnostics'),
      diagnostics: z.array(LspDiagnostic).max(256),
    }),
  ]),
  durationMs: z.int().min(0),
  truncated: z.boolean(),
});
export type LspReport = z.infer<typeof LspReport>;
