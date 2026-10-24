import type { HarnessProfile } from '@corral/contracts';

export const operationId = () => `manage_${crypto.randomUUID()}`;

export function profileInput(p: HarnessProfile): HarnessProfile {
  return {
    name: p.name,
    policy: p.policy,
    allowedTools: p.allowedTools,
    resources: p.resources,
    startupCommands: p.startupCommands,
    ...(p.permissionPolicy ? { permissionPolicy: p.permissionPolicy } : {}),
    ...(p.checkIds === undefined ? {} : { checkIds: p.checkIds }),
    ...(p.lspServerIds === undefined ? {} : { lspServerIds: p.lspServerIds }),
    ...(p.mcpServerIds === undefined ? {} : { mcpServerIds: p.mcpServerIds }),
  };
}
