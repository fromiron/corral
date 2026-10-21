export type ModelImportSource = 'claude-code' | 'codex' | 'opencode' | 'pi';
export interface ModelImportCandidate {
  id: string;
  profileId: string;
  provider: string;
  model: string;
  endpoint: string | null;
  hasKey: boolean;
  supported: boolean;
  reason: string | null;
  warnings: string[];
  change: 'add' | 'replace';
  previous: { provider: string; model: string; endpoint: string | null } | null;
}
export interface ModelImportPreview {
  previewId: string;
  revision: string;
  source: ModelImportSource;
  candidates: ModelImportCandidate[];
}
export interface ModelImportCommit {
  previewId: string;
  revision: string;
  selected: { id: string; copyKey: boolean }[];
}
export interface ModelCatalogMetadata {
  source: 'models.dev';
  version: 1;
  hash: string | null;
  fetchedAt: string | null;
  stale: boolean;
  error: string | null;
  models: {
    provider: string;
    id: string;
    name: string;
    inputCost?: number;
    outputCost?: number;
    contextWindow?: number;
  }[];
}
