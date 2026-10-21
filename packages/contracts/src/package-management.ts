import { z } from 'zod';
import type { HarnessProfileRevision, HarnessResource, HarnessResourceView } from './harness.ts';
import { Identifier } from './ids.ts';
import { McpUrl, RegisteredMcpServer } from './project-tools.ts';

const credentialName =
  /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|authorization|credential)$/i;
const declarationArgument = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => {
    // The import is a portable declaration, never a reference to another user's local files.
    const token = value.replace(/^--?[^=]+=/, '');
    return (
      !/[\p{Cc}]/u.test(value) &&
      !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(token) &&
      !/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(token) &&
      !credentialName.test(value.replace(/^--?/, '').split('=')[0] ?? '')
    );
  }, 'package arguments cannot contain local absolute paths, traversal, or credential flags');
const declarationUrl = McpUrl.refine((value) => {
  try {
    return (value.split('?')[1] ?? '')
      .split('&')
      .every((pair) => !credentialName.test(decodeURIComponent(pair.split('=')[0] ?? '')));
  } catch {
    return false;
  }
}, 'configure credentials separately after import');
const McpContribution = z.discriminatedUnion('transport', [
  z.strictObject({
    id: RegisteredMcpServer.options[0].shape.id,
    name: RegisteredMcpServer.options[0].shape.name,
    transport: z.literal('stdio'),
    argv: z.array(declarationArgument).min(1).max(30),
  }),
  z.strictObject({
    id: RegisteredMcpServer.options[0].shape.id,
    name: RegisteredMcpServer.options[0].shape.name,
    transport: z.literal('http'),
    url: declarationUrl,
  }),
]);

/** Reviewed declarations only. None of these fields grants permission or executes code. */
export const CorralPackageManifest = z
  .strictObject({
    version: z.literal(1),
    requestedCapabilities: z.array(Identifier).max(128).default([]),
    mcpServers: z.array(McpContribution).max(16).default([]),
    ui: z
      .array(
        z.strictObject({
          id: Identifier,
          slot: z.literal('package-details'),
          title: z.string().trim().min(1).max(100),
          /** Render as plain text; never HTML, markdown with embedded HTML, or renderer code. */
          body: z.string().max(12000),
        }),
      )
      .max(16)
      .default([]),
  })
  .refine(
    (value) =>
      [value.mcpServers, value.ui].every(
        (entries) => new Set(entries.map((entry) => entry.id)).size === entries.length,
      ) && new Set(value.requestedCapabilities).size === value.requestedCapabilities.length,
    'duplicate package contribution',
  );
export type PackageManifestMetadata = z.infer<typeof CorralPackageManifest>;
export interface PackageManagementState {
  managementRevision: number;
  status: 'enabled' | 'disabled' | 'removed';
  updatedAt: string | null;
}
export interface PackageView extends PackageManagementState {
  resource: HarnessResourceView;
  manifest: PackageManifestMetadata | null;
  profiles: Pick<HarnessProfileRevision, 'profileId' | 'revision' | 'name'>[];
}
export interface PackageReview {
  reviewId: string;
  resource: HarnessResource;
  manifest: PackageManifestMetadata | null;
  previous?: { hash: string; name: string; version: string };
  changes?: { added: string[]; removed: string[]; changed: string[] };
}
