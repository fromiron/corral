import { z } from 'zod';
import { ContentHash } from './harness.ts';
import { Identifier } from './ids.ts';
import { WorkspaceTarget } from './workbench.ts';

const Argv = z
  .array(
    z
      .string()
      .min(1)
      .max(500)
      .refine((value) => !value.includes('\0')),
  )
  .min(1)
  .max(30);
export const DeploymentEnvRef = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
  .refine(
    (value) =>
      !/^(?:PATH|HOME|USERPROFILE|SHELL|COMSPEC|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|CI|LANG|NODE_OPTIONS|NODE_PATH)$|^(?:CORRAL_|ELECTRON_|LD_|DYLD_|GIT_|NPM_|XDG_)/.test(
        value,
      ),
    'runtime environment variables cannot be overridden',
  );
export const RegisteredDeployment = z.strictObject({
  id: Identifier,
  name: z.string().trim().min(1).max(80),
  environment: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/),
  argv: Argv,
  readbackArgv: Argv,
  timeoutMs: z.int().min(1000).max(1800000),
  envRefs: z
    .array(DeploymentEnvRef)
    .max(30)
    .refine((items) => new Set(items).size === items.length),
});
export type RegisteredDeployment = z.infer<typeof RegisteredDeployment>;
export const DeploymentInspect = z.strictObject({ target: WorkspaceTarget, profileId: Identifier });
export type DeploymentInspect = z.infer<typeof DeploymentInspect>;
export const DeploymentSource = z.strictObject({
  commit: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .nullable(),
  tree: z.string().regex(/^[a-f0-9]{40,64}$/),
  dirty: z.boolean(),
});
export const DeploymentPlan = z.strictObject({
  target: WorkspaceTarget,
  profile: RegisteredDeployment,
  configRevision: z.int().min(1),
  source: DeploymentSource,
  fingerprint: ContentHash,
});
export type DeploymentPlan = z.infer<typeof DeploymentPlan>;
export const DeploymentStart = DeploymentInspect.extend({
  operationId: Identifier,
  fingerprint: ContentHash,
  allowDirty: z.boolean(),
});
export type DeploymentStart = z.infer<typeof DeploymentStart>;
export const DeploymentAction = z.strictObject({ target: WorkspaceTarget });
export type DeploymentAction = z.infer<typeof DeploymentAction>;
export const DeploymentReadback = z.strictObject({
  operationId: Identifier,
  environment: RegisteredDeployment.shape.environment,
  sourceCommit: DeploymentSource.shape.commit,
  sourceTree: DeploymentSource.shape.tree,
  deploymentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/),
  status: z.enum(['succeeded', 'failed', 'pending']),
  url: z
    .url()
    .max(2000)
    .nullable()
    .refine((value) => {
      if (value === null) return true;
      return (
        !/[\s\p{Cc}]/u.test(value) &&
        (/^https:\/\/[^/?#@]+(?:\/[^?#]*)?$/i.test(value) ||
          /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^?#]*)?$/i.test(value))
      );
    }, 'deployment URLs require HTTPS or loopback HTTP without credentials or query data'),
});
export type DeploymentReadback = z.infer<typeof DeploymentReadback>;
export interface DeploymentView {
  operationId: string;
  target: z.infer<typeof WorkspaceTarget>;
  state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain';
  plan: DeploymentPlan;
  phase: 'deploy' | 'readback' | 'settled';
  exitCode: number | null;
  cleanupConfirmed: boolean;
  readback: DeploymentReadback | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface DeploymentList {
  profiles: RegisteredDeployment[];
  deployments: DeploymentView[];
}
