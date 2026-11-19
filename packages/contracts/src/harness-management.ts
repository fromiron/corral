import { z } from 'zod';
import type { AgentRole, RoleMcpToolRef, RoleSkillRef } from './definition.ts';
import type {
  EffectiveHarnessSnapshot,
  HarnessProfileRevision,
  HarnessResourceView,
} from './harness.ts';
import { ContentHash, HarnessBindingRef, HarnessProfile, ResourcePath } from './harness.ts';
import { Identifier } from './ids.ts';
import { McpUrl, RegisteredMcpServer } from './project-tools.ts';

export const HarnessEntryKey = z.strictObject({
  resourceHash: ContentHash,
  entry: ResourcePath,
  kind: z.enum(['skill', 'extension']),
});
export type HarnessEntryKey = z.infer<typeof HarnessEntryKey>;
export const ManagedHook = z.strictObject({
  template: z.enum(['notify', 'confirm']),
  title: z.string().trim().min(1).max(300),
  message: z.string().max(12000),
});
export type ManagedHook = z.infer<typeof ManagedHook>;
export const HarnessDocumentDraft = z.strictObject({
  kind: z.enum(['skill', 'extension']),
  name: z.string().trim().min(1).max(100),
  content: z.string().min(1).max(65536),
  hook: ManagedHook.optional(),
  base: HarnessEntryKey.optional(),
});
export type HarnessDocumentDraft = z.infer<typeof HarnessDocumentDraft>;
export interface HarnessManagementState {
  managementRevision: number;
  archivedAt: string | null;
}
export interface HarnessEntryView extends HarnessEntryKey, HarnessManagementState {
  name: string;
  description: string;
  resource: Omit<HarnessResourceView, 'files'> & { fileCount: number };
  successor: HarnessEntryKey | null;
  profiles: Pick<HarnessProfileRevision, 'profileId' | 'revision' | 'name'>[];
}
export interface HarnessProfileView extends HarnessProfileRevision, HarnessManagementState {
  usages: { id: string; scope: 'personal' | 'project' | 'role'; name: string; revision: number }[];
}
export type HarnessPreviewRole = Pick<AgentRole, 'id' | 'harness' | 'skills' | 'mcpTools'>;
export interface HarnessPreview {
  snapshot: EffectiveHarnessSnapshot;
  sections: { source: 'skill'; name: string; text: string }[];
  dynamic: boolean;
}
export interface RoleSkillProblem {
  roleId: string;
  reason: 'unusable_skills' | 'execution_policy_required';
  entries: (RoleSkillRef & { reason: 'missing' | 'disabled' | 'untrusted' | 'name_conflict' })[];
}
export const RoleMcpToolProblemReason = z.enum([
  'execution_policy_required',
  'server_missing',
  'server_disabled',
  'server_not_selected',
  'tool_not_allowed',
]);
export type RoleMcpToolProblemReason = z.infer<typeof RoleMcpToolProblemReason>;
export interface RoleMcpToolProblem {
  roleId: string;
  tools: (RoleMcpToolRef & { reason: RoleMcpToolProblemReason })[];
}

/** Only structured selection failures may cross from harness resolution into a run refusal. */
export class RoleHarnessResolutionError extends Error {
  readonly problem: RoleSkillProblem | null;
  readonly mcpProblem: RoleMcpToolProblem | undefined;
  constructor(problem: RoleSkillProblem | null, mcpProblem?: RoleMcpToolProblem) {
    super(
      `Harness unavailable for role ${problem?.roleId ?? mcpProblem?.roleId}: ${problem?.reason ?? mcpProblem?.tools[0]?.reason}`,
    );
    this.problem = problem;
    this.mcpProblem = mcpProblem;
  }
}

export function isHarnessMcpTool(name: string): boolean {
  return (
    name.startsWith('mcp__') ||
    name === 'list_mcp_resources' ||
    name === 'list_mcp_resource_templates' ||
    name === 'read_mcp_resource'
  );
}

/** Check the resolver's output at both run boundaries without resolving a second policy. */
export function matchesRoleMcpSelection(
  role: Pick<AgentRole, 'harness' | 'mcpTools'>,
  snapshot: EffectiveHarnessSnapshot,
): boolean {
  if (!role.mcpTools) return true;
  if (role.mcpTools.length && (!role.harness || snapshot.policy !== 'trusted-native')) return false;
  const names = new Set(role.mcpTools.map((ref) => ref.name));
  const servers = new Set(role.mcpTools.map((ref) => ref.serverId));
  const serverIds = snapshot.projectTools?.mcpServerIds ?? [];
  return (
    snapshot.allowedTools.every((name) => !isHarnessMcpTool(name) || names.has(name)) &&
    snapshot.tools.every(({ name }) => !isHarnessMcpTool(name) || names.has(name)) &&
    role.mcpTools.every(
      (ref) => snapshot.allowedTools.includes(ref.name) && serverIds.includes(ref.serverId),
    ) &&
    serverIds.every((id) => servers.has(id))
  );
}

export type RoleHarnessPreview =
  | HarnessPreview
  | { snapshot: null; problem: RoleSkillProblem | null; mcpProblem?: RoleMcpToolProblem };
export const HarnessPublish = z.strictObject({
  operationId: Identifier,
  profileId: Identifier,
  expectedRevision: z.int().min(0),
  profile: HarnessProfile,
  target: z
    .strictObject({
      scope: z.enum(['personal', 'project']),
      scopeId: Identifier,
      expectedRevision: z.int().min(0),
      binding: HarnessBindingRef.nullable(),
      projectToolsRevision: z.int().min(0).optional(),
    })
    .refine((target) => target.scope !== 'personal' || target.scopeId === 'default')
    .optional(),
});
export type HarnessPublish = z.infer<typeof HarnessPublish>;

const McpDraftCommon = {
  name: RegisteredMcpServer.options[0].shape.name,
  enabled: z.boolean(),
  exposure: z.enum(['direct', 'codemode']),
  timeoutMs: RegisteredMcpServer.options[0].shape.timeoutMs,
};
export const McpServerDraft = z.discriminatedUnion('transport', [
  z.strictObject({
    ...McpDraftCommon,
    transport: z.literal('stdio'),
    argv: RegisteredMcpServer.options[0].shape.argv,
    browser: RegisteredMcpServer.options[0].shape.browser,
  }),
  z.strictObject({
    ...McpDraftCommon,
    transport: z.literal('http'),
    url: McpUrl,
    auth: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('none') }),
      z.strictObject({ kind: z.literal('bearer') }),
      z.strictObject({
        kind: z.literal('oauth'),
        scope: z.string().trim().min(1).max(2000),
        clientId: z.string().min(1).max(500).optional(),
      }),
    ]),
  }),
]);
export type McpServerDraft = z.infer<typeof McpServerDraft>;
