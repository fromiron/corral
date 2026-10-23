import { z } from 'zod';
import { ContentSearch } from './content-search.ts';
import { ContentHash, ResourcePath } from './harness.ts';
import { Identifier } from './ids.ts';
import { LanguageScope } from './language-session.ts';
import { LspPosition, LspRange } from './lsp.ts';
import { type WorkbenchOperation, WorkspaceTarget } from './workbench.ts';

const RefactorScope = LanguageScope.extend({
  clientId: Identifier,
  path: ResourcePath,
  version: z.int().min(1),
});
export const LanguageRefactor = z.discriminatedUnion('kind', [
  RefactorScope.extend({
    kind: z.literal('rename'),
    position: LspPosition,
    newName: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => !/[\r\n\0]/.test(value)),
  }),
  RefactorScope.extend({ kind: z.literal('code_actions'), range: LspRange }),
]);
export type LanguageRefactor = z.infer<typeof LanguageRefactor>;
export const LanguageRefactorSource = z.strictObject({
  generation: Identifier,
  clientId: Identifier,
  serverId: Identifier,
  configRevision: z.int().min(1),
  fingerprint: ContentHash,
  path: ResourcePath,
  version: z.int().min(1),
});
export type LanguageRefactorSource = z.infer<typeof LanguageRefactorSource>;
export const ProposedTextFile = z.strictObject({
  path: ResourcePath,
  before: z.string().max(1024 * 1024),
  beforeHash: ContentHash,
  after: z.string().max(1024 * 1024),
  afterHash: ContentHash,
});
export type ProposedTextFile = z.infer<typeof ProposedTextFile>;
export interface UnsupportedFileEdit {
  title: string;
  reason: 'command' | 'disabled' | 'no_edit' | 'resource_operation';
}
export interface LanguageRefactorResult {
  source: LanguageRefactorSource;
  actions: { title: string; files: ProposedTextFile[] }[];
  unavailable: UnsupportedFileEdit[];
}
export const FileEditPreview = z.discriminatedUnion('kind', [
  ContentSearch.omit({ queryId: true }).extend({
    kind: z.literal('replace'),
    requestId: Identifier,
    replacement: z.string().max(1024 * 1024),
  }),
  ...LanguageRefactor.options.map((schema) => schema.extend({ requestId: Identifier })),
]);
export type FileEditPreview = z.infer<typeof FileEditPreview>;
export const FileEditSource = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('replace'),
    query: z.string().min(1).max(200),
    caseSensitive: z.boolean(),
    replacement: z.string().max(1024 * 1024),
  }),
  z.strictObject({
    kind: z.literal('language'),
    operation: z.enum(['rename', 'code_actions']),
    language: LanguageRefactorSource,
  }),
  z.strictObject({ kind: z.literal('inverse'), proposalId: Identifier, operationId: Identifier }),
]);
export const FileEditProposalContent = z.strictObject({
  proposalId: Identifier,
  target: WorkspaceTarget,
  title: z.string().max(400),
  source: FileEditSource,
  files: z.array(ProposedTextFile).min(1).max(32),
  createdAt: z.iso.datetime(),
});
export type FileEditProposalContent = z.infer<typeof FileEditProposalContent>;
export type FileEditProposal = FileEditProposalContent & {
  hash: string;
  dismissed: boolean;
  operationId: string | null;
};
export type FileEditProposalSummary = Omit<FileEditProposal, 'files' | 'source'> & {
  files: Pick<ProposedTextFile, 'path' | 'beforeHash' | 'afterHash'>[];
};
export interface FileEditPreviewResult {
  proposals: FileEditProposal[];
  unavailable: UnsupportedFileEdit[];
}
export const FileEditDecision = z.strictObject({
  target: WorkspaceTarget,
  proposalHash: ContentHash,
});
export type FileEditDecision = z.infer<typeof FileEditDecision>;
export const FileEditApply = FileEditDecision.extend({ operationId: Identifier });
export type FileEditApply = z.infer<typeof FileEditApply>;
export const FileEditInverse = FileEditDecision.extend({
  requestId: Identifier,
  operationId: Identifier,
});
export type FileEditInverse = z.infer<typeof FileEditInverse>;
export const FileEditReconcile = z.strictObject({
  target: WorkspaceTarget,
  operationId: Identifier,
});
export type FileEditReconcile = z.infer<typeof FileEditReconcile>;
export interface FileEditOutcome {
  path: string;
  state: 'pending' | 'applied' | 'unchanged' | 'uncertain';
}
export interface FileEditOperation extends WorkbenchOperation {
  kind: 'document.batch';
  result: {
    proposalId: string;
    proposalHash: string;
    outcomes: FileEditOutcome[];
    error: { code: string; message: string } | null;
  };
}
