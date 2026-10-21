export const VAULT_DOMAINS = [
  'application',
  'providers',
  'mcp',
  'skills',
  'subagents',
  'instructions',
  'plugins',
  'automation',
  'memory',
] as const;
export type VaultDomain = (typeof VAULT_DOMAINS)[number];
export interface VaultDomainSnapshot {
  revision: string;
  value: unknown;
}
/** Each domain retains its existing owner and validation path. No raw DB/files restoration. */
export interface VaultDomainAdapter {
  capture(options?: {
    purpose?: 'export' | 'rollback';
    includeSecrets?: string[];
  }): Promise<VaultDomainSnapshot>;
  preview(
    value: unknown,
    bindings: Record<string, string>,
  ): Promise<{ value: unknown; warnings: string[] }>;
  apply(
    value: unknown,
    expectedRevision: string,
    operationId: string,
  ): Promise<{ revision: string }>;
  restore(
    snapshot: VaultDomainSnapshot,
    expectedRevision: string,
    operationId: string,
  ): Promise<{ revision: string }>;
  receipt?(
    operationId: string,
  ): Promise<{ revision: string; state?: 'partial' | 'complete' } | null>;
}
export interface VaultDocument {
  version: 1;
  createdAt: string;
  domains: Partial<Record<VaultDomain, VaultDomainSnapshot>>;
}
