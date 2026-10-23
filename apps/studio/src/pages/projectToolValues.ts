import type { ProjectToolConfig, ProjectToolConfigRevision } from '@corral/contracts';

/** Keep other tool families when one settings form saves its own fields. */
export function projectToolValues(config: ProjectToolConfigRevision | null): ProjectToolConfig {
  if (!config) return { checks: [], lspServers: [] };
  const {
    projectId: _project,
    revision: _revision,
    hash: _hash,
    createdAt: _created,
    ...values
  } = config;
  return values;
}
