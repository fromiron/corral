import { z } from 'zod';
import { ContentHash, ResourcePath } from './harness.ts';
import { Identifier } from './ids.ts';
import { LspDiagnostic, LspPosition, LspRange } from './lsp.ts';
import type { RegisteredLspServer } from './project-tools.ts';
import { WorkspaceTarget } from './workbench.ts';

export const LanguageInspect = z.strictObject({ target: WorkspaceTarget, serverId: Identifier });
export type LanguageInspect = z.infer<typeof LanguageInspect>;
export interface LanguageInspection {
  target: WorkspaceTarget;
  server: RegisteredLspServer;
  configRevision: number;
  fingerprint: string;
  trusted: boolean;
}
export const LanguageStart = LanguageInspect.extend({
  clientId: Identifier,
  requestId: Identifier,
  configRevision: z.int().min(1),
  fingerprint: ContentHash,
  trust: z.boolean().default(false),
});
export type LanguageStart = z.infer<typeof LanguageStart>;
export const LanguageScope = z.strictObject({ target: WorkspaceTarget, generation: Identifier });
export type LanguageScope = z.infer<typeof LanguageScope>;
const DocumentScope = LanguageScope.extend({
  clientId: Identifier,
  path: ResourcePath,
  version: z.int().min(1),
});
export const LanguageDocumentChange = z.discriminatedUnion('kind', [
  DocumentScope.extend({
    kind: z.literal('sync'),
    languageId: z.string().min(1).max(60),
    text: z.string().max(1024 * 1024),
  }),
  DocumentScope.extend({ kind: z.literal('close') }),
]);
export type LanguageDocumentChange = z.infer<typeof LanguageDocumentChange>;
export const LanguageQuery = DocumentScope.extend({
  operation: z.enum(['completion', 'definition', 'references', 'diagnostics']),
  position: LspPosition.optional(),
});
export type LanguageQuery = z.infer<typeof LanguageQuery>;
export interface LanguageCapabilities {
  completion: boolean;
  definition: boolean;
  references: boolean;
  rename: boolean;
  codeActions: boolean;
  diagnostics: boolean;
  diagnosticPull: boolean;
  triggerCharacters: string[];
}
export interface LanguageDiagnostics {
  path: string;
  documentVersion: number | null;
  diagnostics: z.infer<typeof LspDiagnostic>[];
}
export interface LanguageSession {
  generation: string;
  clientId: string;
  serverId: string;
  configRevision: number;
  fingerprint: string;
  state: 'starting' | 'running' | 'failed' | 'uncertain';
  capabilities: LanguageCapabilities;
  diagnostics: LanguageDiagnostics[];
  error: string | null;
}
export interface LanguageState {
  target: WorkspaceTarget;
  available: boolean;
  unavailableReason: 'platform' | 'untrusted' | null;
  servers: Pick<RegisteredLspServer, 'id' | 'name' | 'languageIds' | 'fileExtensions'>[];
  session: LanguageSession | null;
}
export const LanguageCompletion = z.strictObject({
  label: z.string().min(1).max(500),
  insertText: z.string().max(16000),
  kind: z.int().min(1).max(25).optional(),
  detail: z.string().max(2000).optional(),
  sortText: z.string().max(500).optional(),
  filterText: z.string().max(500).optional(),
  range: LspRange.optional(),
});
export type LanguageCompletion = z.infer<typeof LanguageCompletion>;
export const LanguageLocation = z.strictObject({
  path: ResourcePath,
  range: LspRange,
  sha256: ContentHash,
  documentVersion: z.int().min(1).nullable(),
});
export type LanguageLocation = z.infer<typeof LanguageLocation>;
export const LanguageQueryResult = z.strictObject({
  generation: Identifier,
  documentVersion: z.int().min(1),
  result: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('completion'), items: z.array(LanguageCompletion).max(200) }),
    z.strictObject({ kind: z.literal('locations'), locations: z.array(LanguageLocation).max(256) }),
    z.strictObject({
      kind: z.literal('diagnostics'),
      diagnostics: z.array(LspDiagnostic).max(256),
    }),
  ]),
});
export type LanguageQueryResult = z.infer<typeof LanguageQueryResult>;
