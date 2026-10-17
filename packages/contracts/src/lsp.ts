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
  z.strictObject({
    ...QueryHead,
    operation: z.literal('rename'),
    position: LspPosition,
    newName: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => !/[\r\n\0]/.test(value)),
  }),
  z.strictObject({
    ...QueryHead,
    operation: z.literal('code_actions'),
    range: LspRange,
    only: z.array(z.string().min(1).max(100)).max(20).optional(),
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
  operation: z.enum(['diagnostics', 'definition', 'references', 'rename', 'code_actions']),
  configRevision: z.int().min(1),
  fingerprint: ContentHash,
  tree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  source: z.strictObject({ path: ResourcePath, sha256: ContentHash, version: z.literal(1) }),
  result: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('proposals'),
      proposals: z
        .array(
          z.strictObject({
            proposalId: Identifier,
            hash: ContentHash,
            title: z.string().max(400),
            files: z
              .array(
                z.strictObject({
                  path: ResourcePath,
                  beforeHash: ContentHash,
                  afterHash: ContentHash,
                }),
              )
              .max(32),
          }),
        )
        .max(32),
      unavailable: z
        .array(
          z.strictObject({
            title: z.string().max(400),
            reason: z.enum(['command', 'disabled', 'no_edit']),
          }),
        )
        .max(32),
    }),
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

export const LspProposalFile = z.strictObject({
  path: ResourcePath,
  beforeHash: ContentHash,
  afterHash: ContentHash,
  before: z.string().max(1024 * 1024),
  after: z.string().max(1024 * 1024),
});
export const LspProposalContent = z.strictObject({
  proposalId: Identifier,
  sessionId: Identifier,
  runId: Identifier,
  executionId: Identifier,
  attemptNo: z.int().min(1),
  effectId: Identifier,
  serverId: Identifier,
  configRevision: z.int().min(1),
  fingerprint: ContentHash,
  tree: LspReport.shape.tree,
  worktreeHash: ContentHash,
  source: LspReport.shape.source,
  title: z.string().max(400),
  files: z.array(LspProposalFile).min(1).max(32),
  createdAt: z.iso.datetime(),
});
export type LspProposalContent = z.infer<typeof LspProposalContent>;
export const LspProposalState = z.enum([
  'pending',
  'applying',
  'applied',
  'partial',
  'failed',
  'stale',
  'dismissed',
]);
const Application = {
  hash: ContentHash,
  state: LspProposalState,
  outcomes: z
    .array(
      z.strictObject({
        path: ResourcePath,
        state: z.enum(['pending', 'applied', 'failed', 'uncertain']),
      }),
    )
    .max(32),
};
export const LspProposal = LspProposalContent.extend(Application);
export type LspProposal = z.infer<typeof LspProposal>;
export const LspProposalSummary = LspProposalContent.extend({
  ...Application,
  files: z.array(LspProposalFile.omit({ before: true, after: true })).max(32),
});
export type LspProposalSummary = z.infer<typeof LspProposalSummary>;
