import { FILE_TOOLS } from '@corral/contracts';
import type { CorralRepository } from '@corral/core';
import { emptyDraft } from '@corral/react';
import { type DemoTemplateId, templateForWorkspace } from './demo/templates.ts';
import type { WorkspacesClient } from './demo/workspaces-client.ts';

export type WorkspaceTemplateId = DemoTemplateId | 'blank';

export const WORKSPACE_TEMPLATES: readonly WorkspaceTemplateId[] = [
  'research-team',
  'starter',
  'blank',
];

/** Saves a new Corral from a template and returns its id, or an error message. */
export async function createFromTemplate(
  repository: CorralRepository,
  id: WorkspaceTemplateId,
  blankName: string,
  projectId?: string,
): Promise<{ ok: true; corralId: string } | { ok: false; message: string }> {
  const suffix = globalThis.crypto.randomUUID().slice(0, 8);
  const draft =
    id === 'blank'
      ? (() => {
          const empty = emptyDraft('untitled', blankName);
          return {
            definition: empty.definition,
            layout: { nodes: empty.layout, viewport: empty.viewport },
          };
        })()
      : (() => {
          const template = templateForWorkspace(id, `${id.replace('-', '_')}_${suffix}`);
          return { definition: template.definition, layout: template.layout };
        })();
  const result = await repository.save({
    ...draft,
    expectedDefinitionRevision: null,
    ...(projectId ? { projectId } : {}),
  });
  return result.ok
    ? { ok: true, corralId: result.record.corralId }
    : { ok: false, message: result.message };
}

/**
 * Example projects for the in-browser demo: two projects, a team each and
 * six sessions with their purposes. Simulated runs only; nothing here is a real record.
 */
export async function createDemoExamples(
  repository: CorralRepository,
  workspaces: WorkspacesClient | null,
  text: {
    projects: [string, string];
    sessions: [string, string, string, string, string, string];
    teamName: string;
  },
): Promise<string | null> {
  const plan: { name: string; template: WorkspaceTemplateId; sessions: string[] }[] = [
    { name: text.projects[0], template: 'research-team', sessions: text.sessions.slice(0, 3) },
    { name: text.projects[1], template: 'starter', sessions: text.sessions.slice(3, 6) },
  ];
  let first: string | null = null;
  for (const [index, entry] of plan.entries()) {
    const project = await repository.createProject({ name: entry.name });
    if (!project.ok) return first;
    first ??= project.project.projectId;
    const team = await createFromTemplate(
      repository,
      entry.template,
      text.teamName,
      project.project.projectId,
    );
    const sessionIds: string[] = [];
    for (const objective of entry.sessions) {
      const made = await repository.createSession({
        projectId: project.project.projectId,
        title: '',
        objective,
        corralId: team.ok ? team.corralId : null,
      });
      if (made.ok) sessionIds.push(made.session.sessionId);
    }
    // The second project works on files: a linked example folder, a team that may change
    // files, and a working copy for its first session.
    if (index === 1 && workspaces && team.ok) {
      const record = await repository.get(team.corralId);
      if (record) {
        const definition = {
          ...record.definition,
          roles: record.definition.roles.map((role) => ({
            ...role,
            allowedWorkTools: [...new Set([...role.allowedWorkTools, ...FILE_TOOLS])],
          })),
        };
        await repository.save({
          definition,
          layout: { nodes: record.layout.nodes, viewport: record.layout.viewport },
          expectedDefinitionRevision: record.definitionRevision,
        });
      }
      const projectId = project.project.projectId;
      await workspaces.bind(projectId, 'demo://example-repo').catch(() => null);
      await workspaces.configure(projectId, { trusted: true }).catch(() => null);
      if (sessionIds[0]) await workspaces.createWorktree(sessionIds[0]).catch(() => null);
    }
  }
  return first;
}
