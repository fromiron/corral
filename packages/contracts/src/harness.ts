import { z } from 'zod';
import { Identifier } from './ids.ts';
import { ReasoningWire } from './reasoning.ts';

/** A Run-scoped restriction, never an expansion of capability or existing policies. */
export const PermissionMode = z.enum(['ask', 'accept_edits', 'auto']);
export type PermissionMode = z.infer<typeof PermissionMode>;

/** An immutable profile revision, never a path or a mutable "latest" alias (CR-018). */
export const HarnessBindingRef = z.strictObject({
  profileId: Identifier,
  revision: z.int().min(1),
});
export type HarnessBindingRef = z.infer<typeof HarnessBindingRef>;
export const HarnessOverrides = z
  .record(Identifier, HarnessBindingRef)
  .refine((value) => Object.keys(value).length <= 20, 'too many role overrides')
  .meta({ maxProperties: 20 });
export type HarnessOverrides = z.infer<typeof HarnessOverrides>;

export const ContentHash = z.string().regex(/^[a-f0-9]{64}$/);
export const PinnedPackageSource = z
  .string()
  .max(1000)
  .regex(
    /^(?:npm:(?:@[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9_.-]*@\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?|git:https:\/\/[a-zA-Z0-9][a-zA-Z0-9.-]*(?::\d+)?\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*@[a-f0-9]{40})$/,
  );
/** Paths inside a copied resource bundle, never paths on the person's computer. */
export const ResourcePath = z
  .string()
  .min(1)
  .max(500)
  .regex(/^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)[^\\\p{Cc}]+$/u);

export const ToolDescriptor = z.strictObject({
  source: z.union([
    z.literal('corral'),
    z.string().regex(/^extension:[@a-zA-Z0-9_./-]+@[a-zA-Z0-9_.+-]+$/),
  ]),
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
  schemaHash: ContentHash,
  annotations: z
    .strictObject({
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })
    .optional(),
  exposure: z.enum(['direct', 'model-only', 'codemode', 'deferred', 'hidden']),
  sideEffect: z.enum(['none', 'workspace', 'external', 'unknown']),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptor>;
export const ToolPermissionPolicy = z.strictObject({
  default: z.enum(['ask', 'deny']),
  rules: z
    .array(
      z
        .strictObject({
          tool: ToolDescriptor.shape.name,
          action: z.enum(['allow', 'ask', 'deny']),
          descriptorHash: ContentHash.optional(),
          arguments: z
            .record(
              z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
              z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]),
            )
            .refine((value) => Object.keys(value).length <= 16, 'too many argument conditions')
            .optional(),
          path: z
            .strictObject({
              argument: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
              prefix: ResourcePath,
            })
            .optional(),
        })
        .refine(
          (rule) => rule.action !== 'allow' || rule.descriptorHash !== undefined,
          'allow requires an exact descriptor hash',
        ),
    )
    .max(64),
});
export type ToolPermissionPolicy = z.infer<typeof ToolPermissionPolicy>;
export const ToolPermissionPlan = z.strictObject({
  purpose: z.literal('tool'),
  descriptor: ToolDescriptor,
  arguments: z.record(z.string(), z.unknown()),
  argumentsHash: ContentHash,
  descriptorHash: ContentHash,
  snapshotHash: ContentHash,
  policyRevision: z.int().min(1),
  fingerprint: ContentHash,
});
export type ToolPermissionPlan = z.infer<typeof ToolPermissionPlan>;

export const HarnessToolsUpdate = z.strictObject({
  snapshotHash: ContentHash,
  expectedRevision: z.int().min(1),
  tools: z.array(ToolDescriptor).max(128),
});
export type HarnessToolsUpdate = z.infer<typeof HarnessToolsUpdate>;

/** References only: no local paths, skill text, credentials or extension error messages. */
export const HarnessResourceRef = z.strictObject({
  hash: ContentHash,
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(100),
  kind: z.enum(['skill', 'extension']),
  required: z.boolean(),
  skillMode: z.enum(['auto', 'explicit', 'mandatory']).optional(),
  entry: ResourcePath.optional(),
  skillName: Identifier.optional(),
});
export const EffectiveHarnessSnapshot = z.strictObject({
  binding: HarnessBindingRef,
  snapshotHash: ContentHash,
  piVersion: z.literal('1.3.0'),
  policyRevision: z.int().min(1),
  policy: z.enum(['strict', 'trusted-native']),
  resources: z.array(HarnessResourceRef).max(64),
  allowedTools: z.array(ToolDescriptor.shape.name).max(128),
  tools: z.array(ToolDescriptor).max(128),
  permissionPolicies: z.array(ToolPermissionPolicy).max(4).optional(),
  diagnostics: z.array(Identifier).max(64),
  projectTools: z
    .strictObject({
      projectId: Identifier,
      revision: z.int().min(1),
      hash: ContentHash,
      checkIds: z.array(Identifier).max(64),
      lspServerIds: z.array(Identifier).max(16),
      mcpServerIds: z.array(Identifier).max(16).optional(),
    })
    .optional(),
  layers: z
    .array(
      z.strictObject({
        scope: z.enum(['personal', 'project', 'role', 'run']),
        binding: HarnessBindingRef,
      }),
    )
    .max(4)
    .optional(),
});
export type EffectiveHarnessSnapshot = z.infer<typeof EffectiveHarnessSnapshot>;

export const HarnessCommand = z.strictObject({
  name: z.string().regex(/^[\w][\w:.-]{0,119}$/),
  invocation: z.string().regex(/^[\w][\w:.-]{0,239}$/),
  alias: z.string().regex(/^[\w][\w:.-]{0,239}$/),
  source: ToolDescriptor.shape.source,
  description: z.string().max(1000),
  condition: z.literal('startup'),
});
export type HarnessCommand = z.infer<typeof HarnessCommand>;

export const HarnessReport = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    snapshotHash: ContentHash,
    tools: z.array(ToolDescriptor).max(128),
    diagnostics: z.array(Identifier).max(64),
    commands: z.array(HarnessCommand).max(128).optional(),
  }),
  z.strictObject({
    ok: z.literal(false),
    snapshotHash: ContentHash,
    code: z.enum([
      'extension_load_failed',
      'resource_invalid',
      'policy_denied',
      'sdk_start_failed',
    ]),
  }),
]);
export type HarnessReport = z.infer<typeof HarnessReport>;

const UiHead = { title: z.string().min(1).max(300), timeoutMs: z.int().min(1).max(300000) };
export const ExtensionUiRequest = z.discriminatedUnion('kind', [
  z.strictObject({
    ...UiHead,
    kind: z.literal('select'),
    options: z.array(z.string().min(1).max(1000)).min(1).max(100),
  }),
  z.strictObject({ ...UiHead, kind: z.literal('confirm'), message: z.string().max(12000) }),
  z.strictObject({ ...UiHead, kind: z.literal('input'), placeholder: z.string().max(1000) }),
]);
export type ExtensionUiRequest = z.infer<typeof ExtensionUiRequest>;
export const ExtensionUiValue = z.union([z.string().max(12000), z.boolean(), z.null()]);
export const ExtensionUiResult = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('answered'), value: ExtensionUiValue }),
  z.strictObject({ status: z.enum(['cancelled', 'expired']) }),
]);
export type ExtensionUiResult = z.infer<typeof ExtensionUiResult>;
export const ExtensionUiNotice = z.strictObject({
  kind: z.enum(['notify', 'status', 'unsupported']),
  key: z.string().min(1).max(100),
  text: z.string().max(12000),
  level: z.enum(['info', 'warning', 'error']),
});
export type ExtensionUiNotice = z.infer<typeof ExtensionUiNotice>;

/** The final context at the Corral provider boundary, before dispatch. */
export const CompactionReport = z.strictObject({
  commandId: Identifier,
  phase: z.enum(['started', 'completed', 'failed', 'cancelled', 'skipped']),
  beforeHash: ContentHash.optional(),
  afterHash: ContentHash.optional(),
  modelCallIds: z.array(Identifier).max(100),
});
export type CompactionReport = z.infer<typeof CompactionReport>;

export const ProtectedContext = z.strictObject({
  version: z.literal(1),
  text: z.string().max(256 * 1024),
  hash: ContentHash,
});
export type ProtectedContext = z.infer<typeof ProtectedContext>;

export const ContextUsageCategory = z.enum([
  'messages',
  'system_prompt',
  'system_tools',
  'mcp_tools',
  'skills',
  'memory_files',
  'instructions',
  'other',
]);
export type ContextUsageCategory = z.infer<typeof ContextUsageCategory>;

/** Why a category has no trustworthy number. Never a prompt, path, or secret. */
export const ContextUsageOmission = z.enum([
  'unmeasured_image',
  'unsupported_payload',
  'unmeasured_tool',
  'measurement_error',
  'not_in_payload',
]);
export type ContextUsageOmission = z.infer<typeof ContextUsageOmission>;

/**
 * Read-only estimate of one model request. `coverage: messages` is not a full-request ratio.
 * Provider-reported usage is stored separately and is not added into `usedTokens`.
 */
export const ContextUsageSnapshot = z.strictObject({
  version: z.literal(1),
  coverage: z.enum(['messages', 'request']),
  completeness: z.enum(['complete', 'partial', 'unmeasured', 'error']),
  method: z.literal('pi-1.3.0-chars4'),
  usedTokens: z.int().min(0).optional(),
  parts: z
    .array(
      z.strictObject({
        category: ContextUsageCategory,
        tokens: z.int().min(0),
        omission: ContextUsageOmission.optional(),
      }),
    )
    .max(24),
});
export type ContextUsageSnapshot = z.infer<typeof ContextUsageSnapshot>;

export const ModelRequestRecord = z.strictObject({
  purpose: z.enum(['turn', 'compaction', 'retry', 'extension']),
  runtime: z.enum(['pi-core', 'pi-sdk']).optional(),
  contextEstimate: z
    .strictObject({
      tokens: z.int().min(0),
      method: z.enum(['pi-1.3.0-messages', 'dsh-density-v2', 'usage-anchor-v2']),
    })
    .optional(),
  contextUsage: ContextUsageSnapshot.optional(),
  directiveIds: z.array(Identifier).max(256),
  contextHash: ContentHash,
  contextBytes: z
    .int()
    .min(0)
    .max(32 * 1024 * 1024),
  sections: z
    .array(
      z.strictObject({
        name: Identifier,
        source: z.enum(['corral', 'skill', 'runtime']),
        version: z.int().min(1).optional(),
        reason: Identifier.optional(),
        hash: ContentHash,
        bytes: z.int().min(0),
      }),
    )
    .max(256),
});
export type ModelRequestRecord = z.infer<typeof ModelRequestRecord>;

/** The provider-specific JSON after payload hooks; no headers or credentials. */
export const ProviderPayloadRecord = z.strictObject({
  skills: z
    .array(
      z.strictObject({
        name: Identifier,
        resourceHash: ContentHash,
        bodyHash: ContentHash,
        bytes: z.int().min(1),
      }),
    )
    .max(64)
    .optional(),
  reasoning: ReasoningWire.optional(),
  modelCallId: Identifier,
  payloadHash: ContentHash,
  payloadBytes: z
    .int()
    .min(0)
    .max(32 * 1024 * 1024),
  /** Reconciled after payload hooks. Absent on older events. */
  contextUsage: ContextUsageSnapshot.optional(),
});
export type ProviderPayloadRecord = z.infer<typeof ProviderPayloadRecord>;

export const HarnessProfile = z.strictObject({
  permissionPolicy: ToolPermissionPolicy.optional(),
  name: z.string().trim().min(1).max(100),
  policy: z.enum(['strict', 'trusted-native']),
  allowedTools: z.array(ToolDescriptor.shape.name).max(128),
  resources: z
    .array(
      z.strictObject({
        resourceHash: ContentHash,
        entry: ResourcePath,
        kind: z.enum(['skill', 'extension']),
        required: z.boolean(),
        skillMode: z.enum(['auto', 'explicit', 'mandatory']).optional(),
      }),
    )
    .max(64),
  startupCommands: z.array(z.string().min(1).max(1000)).max(16),
  checkIds: z.array(Identifier).max(64).optional(),
  lspServerIds: z.array(Identifier).max(16).optional(),
  mcpServerIds: z.array(Identifier).max(16).optional(),
});
export type HarnessProfile = z.infer<typeof HarnessProfile>;
export const HarnessProfileRevision = HarnessProfile.extend({
  profileId: Identifier,
  revision: z.int().min(1),
  createdAt: z.iso.datetime(),
});
export type HarnessProfileRevision = z.infer<typeof HarnessProfileRevision>;

export const HarnessResource = z.strictObject({
  hash: ContentHash,
  name: z.string().regex(/^(?:@[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9_.-]*$/),
  version: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,99}$/),
  license: z.string().max(200).nullable(),
  sourceKind: z.enum(['local', 'npm', 'git']),
  sourceLabel: z.string().max(300),
  /** Package location relative to the whole copied install (including its dependencies). */
  packagePath: ResourcePath.nullable(),
  extensions: z.array(ResourcePath).max(64),
  skills: z
    .array(
      z.strictObject({ name: Identifier, description: z.string().max(1000), entry: ResourcePath }),
    )
    .max(64),
  files: z
    .array(z.strictObject({ path: ResourcePath, hash: ContentHash, bytes: z.int().min(0) }))
    .max(10000),
  createdAt: z.iso.datetime(),
});
export type HarnessResource = z.infer<typeof HarnessResource>;
export const PackageInspection = HarnessResource.pick({
  name: true,
  version: true,
  license: true,
  packagePath: true,
  extensions: true,
  skills: true,
});
export type PackageInspection = z.infer<typeof PackageInspection>;
export type HarnessResourceView = HarnessResource & { trustedAt: string | null };
export interface HarnessDefault {
  scope: 'personal' | 'project';
  scopeId: string;
  revision: number;
  binding: HarnessBindingRef | null;
}
