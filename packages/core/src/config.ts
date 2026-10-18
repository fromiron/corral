import { Identifier, type RunLimits, SchemaVersion } from '@corral/contracts';
import { z } from 'zod';

// Workspace configuration and the installation policy (C-062, Spec §9, ADR-019). The config
// file names model profiles and may lower hard caps; it never raises a cap past the spec and
// never holds a credential: keys and tokens come from the server environment only.

export interface InstallationPolicy {
  maxModelConcurrency: number;
  maxSpawns: number;
  maxModelCalls: number;
  maxOutputTokens: number;
  maxOutputTokensPerCall: number;
  maxQuestions: number;
  questionTimeoutMs: number;
  modelTimeoutMs: number;
  runDeadlineMs: number;
  maxLoopIterations: number;
  maxArtifactBytes: number;
  /** Executions alive at once in a run, waiting ones included (Technical-Design §8.1). */
  maxResidentExecutions: number;
}

/**
 * The "hard cap" column of Spec §9. Timeouts have no cap in the spec; the definition schema's
 * maxima stand in for them.
 */
export const SPEC_HARD_CAPS: InstallationPolicy = {
  maxModelConcurrency: 3,
  maxSpawns: 32,
  maxModelCalls: 100,
  maxOutputTokens: 256_000,
  maxOutputTokensPerCall: 4_096,
  maxQuestions: 6,
  questionTimeoutMs: 300_000,
  modelTimeoutMs: 300_000,
  runDeadlineMs: 3_600_000,
  maxLoopIterations: 10,
  maxArtifactBytes: 1024 * 1024,
  maxResidentExecutions: 12,
};

const cap = (max: number) => z.int().min(1).max(max).optional();

// The WHATWG URL parser, present in Node and browsers; core's type library is plain ES2023.
declare const URL: new (
  value: string,
) => {
  protocol: string;
  hostname: string;
  username: string;
  password: string;
  search: string;
  hash: string;
};

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** An endpoint address: https, or http on this computer; no credentials, query or fragment. */
const EndpointUrl = z
  .string()
  .max(500)
  .refine((value) => {
    let url: InstanceType<typeof URL>;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (url.username || url.password || url.search || url.hash) return false;
    return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  }, 'use https, or http only for localhost, 127.0.0.1 or [::1]; no user, query or fragment');

/** An OpenAI-compatible endpoint (CR-005): Ollama, LM Studio, OpenRouter and the like. */
export const ModelProviderConfig = z.strictObject({
  id: Identifier,
  name: z.string().min(1).max(80),
  baseUrl: EndpointUrl,
  /** `api_key`: a key entered under Settings → Models; `none`: a local server without keys. */
  access: z.enum(['api_key', 'none']),
  models: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(200),
        name: z.string().min(1).max(200).optional(),
        contextWindow: z.int().min(1).max(10_000_000).optional(),
        maxOutput: z.int().min(1).max(1_000_000).optional(),
        reasoning: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(50),
});
export type ModelProviderConfig = z.infer<typeof ModelProviderConfig>;

export const WorkspaceConfig = z.strictObject({
  schemaVersion: SchemaVersion,
  hardCaps: z
    .strictObject(
      Object.fromEntries(
        Object.entries(SPEC_HARD_CAPS).map(([field, max]) => [field, cap(max)]),
      ) as Record<keyof InstallationPolicy, ReturnType<typeof cap>>,
    )
    .optional(),
  /** Profile names and the models they map to. Credentials are not configuration. */
  modelProfiles: z
    .array(
      z.strictObject({
        id: Identifier,
        provider: Identifier,
        model: z.string().min(1).max(200),
      }),
    )
    .max(20)
    .optional(),
  /** OpenAI-compatible endpoints the profiles may name (CR-005). Keys are not configuration. */
  modelProviders: z.array(ModelProviderConfig).max(10).optional(),
  /** reasoning_effort judgments (CR-003): observe only, off unless asked for. */
  decisions: z
    .strictObject({
      reasoning_effort: z.strictObject({
        mode: z.enum(['off', 'observe']),
        apply: z.boolean().optional(),
        providers: z.array(Identifier).min(1).max(2),
        maxCalls: z.int().min(0).max(100).optional(),
        allowExternal: z.boolean().optional(),
      }),
    })
    .optional(),
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfig>;

/** The workspace's judgment settings; none configured means off. */
export function judgmentSettings(config: WorkspaceConfig) {
  return config.decisions ?? { reasoning_effort: { mode: 'off' as const, providers: [] } };
}

const CREDENTIAL_KEY = /key|token|secret|password|credential|auth/i;

function credentialPaths(value: unknown, path: string[] = []): string[] {
  if (Array.isArray(value))
    return value.flatMap((item, i) => credentialPaths(item, [...path, `${i}`]));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const here = [...path, key];
    return CREDENTIAL_KEY.test(key) ? [here.join('.')] : credentialPaths(item, here);
  });
}

export type ConfigResult = { ok: true; config: WorkspaceConfig } | { ok: false; errors: string[] };

/** Parses `.corral/config.json`. Errors name fields, never values. */
export function parseWorkspaceConfig(value: unknown): ConfigResult {
  const secrets = credentialPaths(value);
  if (secrets.length > 0) {
    return {
      ok: false,
      errors: secrets.map(
        (path) =>
          `${path}: credentials are entered under Settings → Models or read from the server environment, not from the config file`,
      ),
    };
  }
  const parsed = WorkspaceConfig.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
      ),
    };
  }
  return { ok: true, config: parsed.data };
}

export function installationPolicy(config: WorkspaceConfig): InstallationPolicy {
  return { ...SPEC_HARD_CAPS, ...stripUndefined(config.hardCaps ?? {}) };
}

const LIMIT_FIELDS = [
  'maxModelConcurrency',
  'maxSpawns',
  'maxModelCalls',
  'maxOutputTokens',
  'maxOutputTokensPerCall',
  'maxQuestions',
  'questionTimeoutMs',
  'modelTimeoutMs',
  'runDeadlineMs',
] as const satisfies readonly (keyof RunLimits & keyof InstallationPolicy)[];

/** Every limit a definition asks for above what this installation allows. */
export function limitViolations(
  limits: RunLimits,
  loopRounds: number,
  policy: InstallationPolicy,
): string[] {
  const above = (label: string, value: number, max: number) =>
    value > max ? [`${label} ${value} is above this installation’s cap of ${max}`] : [];
  return [
    ...LIMIT_FIELDS.flatMap((field) => above(field, limits[field], policy[field])),
    ...above('Loop rounds', loopRounds, policy.maxLoopIterations),
  ];
}

function stripUndefined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}
