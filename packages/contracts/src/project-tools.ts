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
const McpCommon = {
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/)
    .refine((value) => !value.includes('__'), 'MCP namespace separator is reserved'),
  name: Launch.name,
  timeoutMs: Launch.timeoutMs.max(300000),
  exposure: z.enum(['direct', 'codemode']),
  enabled: z.boolean().optional(),
};
export const McpAuth = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('bearer'), credentialRef: Identifier }),
  z.strictObject({
    kind: z.literal('oauth'),
    credentialRef: Identifier,
    scope: z.string().trim().min(1).max(2000),
    clientId: z.string().min(1).max(500).optional(),
  }),
]);
export const McpUrl = z
  .url()
  .max(2000)
  .refine((value) => {
    return (
      !/[\s\p{Cc}]/u.test(value) &&
      (/^https:\/\/[^/?#@]+(?:[/?][^#]*)?$/i.test(value) ||
        /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?][^#]*)?$/i.test(value))
    );
  }, 'MCP requires HTTPS or loopback HTTP without URL credentials');
export const LocalBrowserRecipe = z.strictObject({
  fixtureOnly: z.literal(true),
  backendVersion: z.literal('0.0.83'),
  origin: z
    .string()
    .regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$/)
    .refine((value) => {
      const port = Number(value.slice(value.lastIndexOf(':') + 1));
      return port >= 1024 && port <= 65535;
    }, 'one loopback fixture origin on port 1024-65535 is required'),
  executablePath: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (value) => value.startsWith('/') && !value.includes('\0'),
      'an installed browser executable is required',
    ),
  readyText: z.string().trim().min(1).max(200),
});
export type LocalBrowserRecipe = z.infer<typeof LocalBrowserRecipe>;
export const RegisteredMcpServer = z.discriminatedUnion('transport', [
  z.strictObject({
    ...McpCommon,
    transport: z.literal('stdio'),
    argv: Launch.argv,
    browser: LocalBrowserRecipe.optional(),
  }),
  z.strictObject({ ...McpCommon, transport: z.literal('http'), url: McpUrl, auth: McpAuth }),
]);
export type RegisteredMcpServer = z.infer<typeof RegisteredMcpServer>;
/** Private IPC only; never included in run events or exports. */
export const McpChallenge = z.strictObject({
  status: z.union([z.literal(401), z.literal(403)]),
  wwwAuthenticate: z.string().max(4000).optional(),
  rejectedToken: z.string().max(16000).optional(),
});
export type McpChallenge = z.infer<typeof McpChallenge>;
export const ProjectToolConfig = z
  .strictObject({
    checks: z.array(RegisteredCheck).max(64),
    lspServers: z.array(RegisteredLspServer).max(16),
    mcpServers: z.array(RegisteredMcpServer).max(16).optional(),
  })
  .refine(
    (config) =>
      [config.checks, config.lspServers, config.mcpServers ?? []].every(
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
  kind: z.enum(['check', 'lsp', 'mcp']),
  id: Identifier,
  fingerprint: ContentHash,
});
export type ProjectToolTrustTarget = z.infer<typeof ProjectToolTrustTarget>;
