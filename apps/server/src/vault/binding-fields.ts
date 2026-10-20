import type { VaultDomain } from './types.ts';

export interface VaultBindingField {
  key: string;
  label: string;
  kind: 'project' | 'session' | 'team' | 'parent' | 'model' | 'endpoint' | 'text';
}
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const array = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(object) : []);
/** Binding descriptions contain names/IDs only; source credentials and prompts stay server-side. */
export function bindingFields(domain: VaultDomain, raw: unknown): VaultBindingField[] {
  const value = object(raw);
  if (domain === 'instructions' || domain === 'memory')
    return [...new Set(array(value.documents).map((doc) => String(doc.projectId)))].map((id) => ({
      key: `project:${id}`,
      label: `Project ${id}`,
      kind: 'project',
    }));
  if (domain === 'automation')
    return array(value.schedules).flatMap((schedule) => [
      {
        key: `${schedule.sourceId}:projectId`,
        label: `${schedule.title}: project`,
        kind: 'project' as const,
      },
      {
        key: `${schedule.sourceId}:sessionId`,
        label: `${schedule.title}: session`,
        kind: 'session' as const,
      },
    ]);
  if (domain === 'subagents') {
    const definition = object(value.definition);
    const roles = new Set(
      array(definition.nodes)
        .filter((node) => node.type === 'agent' && node.invocation === 'callable')
        .map((node) => node.roleId),
    );
    return [
      { key: 'projectId', label: 'Target project', kind: 'project' },
      { key: 'corralId', label: 'Target team', kind: 'team' },
      { key: 'parentNodeId', label: 'Parent agent', kind: 'parent' },
      ...array(definition.roles)
        .filter((role) => roles.has(role.id))
        .map((role) => ({
          key: `model:${role.id}`,
          label: String(role.name),
          kind: 'model' as const,
        })),
    ];
  }
  if (domain === 'providers')
    return array(value.modelProviders).flatMap((provider) => {
      try {
        return ['localhost', '127.0.0.1', '[::1]'].includes(
          new URL(String(provider.baseUrl)).hostname,
        )
          ? [
              {
                key: `endpoint:${provider.id}`,
                label: String(provider.name),
                kind: 'endpoint' as const,
              },
            ]
          : [];
      } catch {
        return [];
      }
    });
  if (domain === 'mcp')
    return [
      { key: 'projectId', label: 'Target project', kind: 'project' },
      ...array(value.servers).map((server) => ({
        key: `${server.transport === 'http' ? 'endpoint' : 'argv'}:${server.id}`,
        label: `${server.name}: ${server.transport === 'http' ? 'local endpoint URL' : 'local command arguments (JSON array)'}`,
        kind: 'text' as const,
      })),
    ];
  if (domain === 'plugins')
    return array(value.packages).map((item) => ({
      key: `resource:${item.hash}`,
      label: `${item.name}: installed resource hash (leave blank to use the same hash)`,
      kind: 'text',
    }));
  if (domain === 'skills')
    return array(value.entries).map((item) => ({
      key: `resource:${item.resourceHash}`,
      label: `${item.name}: installed resource hash (leave blank to use the same hash)`,
      kind: 'text',
    }));
  return [];
}
