import { z } from 'zod';
import { ContentHash } from './harness.ts';
import { Identifier } from './ids.ts';

const Launch = {
  id: Identifier,
  name: z.string().trim().min(1).max(80),
  argv: z
    .array(
      z
        .string()
        .min(1)
        .max(500)
        .refine((value) => !value.includes('\0'), 'NUL in argument'),
    )
    .min(1)
    .max(30),
  timeoutMs: z
    .int()
    .min(1000)
    .max(30 * 60_000),
};
export const RegisteredCheck = z.strictObject(Launch);
export type RegisteredCheck = z.infer<typeof RegisteredCheck>;
export const RegisteredLspServer = z.strictObject({
  ...Launch,
  languageIds: z
    .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_+-]{0,59}$/))
    .min(1)
    .max(20),
  fileExtensions: z
    .array(z.string().regex(/^\.[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,39}$/))
    .min(1)
    .max(40),
});
export type RegisteredLspServer = z.infer<typeof RegisteredLspServer>;
export const ProjectToolConfig = z
  .strictObject({
    checks: z.array(RegisteredCheck).max(64),
    lspServers: z.array(RegisteredLspServer).max(16),
  })
  .refine(
    (config) =>
      [config.checks, config.lspServers].every(
        (items) => new Set(items.map((item) => item.id)).size === items.length,
      ),
    'duplicate tool ID',
  );
export type ProjectToolConfig = z.infer<typeof ProjectToolConfig>;
export const ProjectToolConfigRevision = ProjectToolConfig.safeExtend({
  projectId: Identifier,
  revision: z.int().min(1),
  hash: ContentHash,
  createdAt: z.iso.datetime(),
});
export type ProjectToolConfigRevision = z.infer<typeof ProjectToolConfigRevision>;
export const ProjectToolTrustTarget = z.strictObject({
  projectId: Identifier,
  kind: z.enum(['check', 'lsp']),
  id: Identifier,
  fingerprint: ContentHash,
});
export type ProjectToolTrustTarget = z.infer<typeof ProjectToolTrustTarget>;
