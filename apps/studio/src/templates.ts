import { type CorralDefinition, FILE_TOOLS } from '@corral/contracts';
import {
  type CorralRepository,
  type CorralSummary,
  compileDefinition,
  DEFAULT_PROJECT_ID,
  type PlanStep,
  type RolePresetId,
  type RoleWording,
  TEAM_TEMPLATE_IDS,
  TEAM_TEMPLATE_ROLES,
  type TeamTemplateId,
  type TeamTemplateLabels,
  type TeamTemplateWording,
  teamTemplate,
} from '@corral/core';
import { emptyDraft } from '@corral/react';
import { useMemo } from 'react';
import { useMessages } from 'use-intl';
import { type DemoTemplateId, templateForWorkspace } from './demo/templates.ts';
import type { WorkspacesClient } from './demo/workspaces-client.ts';

export type WorkspaceTemplateId = DemoTemplateId | TeamTemplateId | 'blank';

/** The library's templates in the order it shows them (docs/specs/features/library.md). */
export const WORKSPACE_TEMPLATES: readonly WorkspaceTemplateId[] = [
  'starter',
  'implement-review',
  'plan-implement-review',
  'bug-fix',
  'parallel-review',
  'tech-decision',
  'research-team',
  'blank',
];

const isTeamTemplate = (id: WorkspaceTemplateId): id is TeamTemplateId =>
  (TEAM_TEMPLATE_IDS as readonly string[]).includes(id);

/** The messages a template is written in: its name, and its roles' names and duties. */
interface TemplateMessages {
  Workspace: { newName: string; template: Record<string, { name: string }> };
  TeamTemplates: {
    presets: Record<RolePresetId, RoleWording>;
    labels: TeamTemplateLabels;
    templates: Record<
      TeamTemplateId,
      { brief: string; criteria: Record<string, string>; roles?: Record<string, RoleWording> }
    >;
  };
}

/** What a template needs from the screen language. */
export interface TemplateText {
  /** A blank team's name. */
  blankName: string;
  /** The wording of a template built from role presets. */
  wording: (id: TeamTemplateId) => TeamTemplateWording;
}

/** A template's own role wording, else its preset's. */
export function templateText(messages: unknown): TemplateText {
  const { Workspace, TeamTemplates } = messages as TemplateMessages;
  return {
    blankName: Workspace.newName,
    wording: (id) => {
      const own = TeamTemplates.templates[id];
      const presets: Readonly<Record<string, RolePresetId>> = TEAM_TEMPLATE_ROLES[id];
      return {
        name: Workspace.template[id]?.name ?? id,
        brief: own.brief,
        criteria: Object.values(own.criteria),
        roles: Object.fromEntries(
          Object.entries(presets).map(([roleId, preset]) => [
            roleId,
            own.roles?.[roleId] ?? TeamTemplates.presets[preset],
          ]),
        ) as TeamTemplateWording['roles'],
        labels: TeamTemplates.labels,
      };
    },
  };
}

export function useTemplateText(): TemplateText {
  const messages = useMessages();
  return useMemo(() => templateText(messages), [messages]);
}

/** The definition a template saves, under `corralId`. */
export function templateDefinition(
  id: WorkspaceTemplateId,
  corralId: string,
  text: TemplateText,
): CorralDefinition {
  if (id === 'blank') return emptyDraft('untitled', text.blankName).definition;
  if (isTeamTemplate(id)) return teamTemplate(id, corralId, text.wording(id));
  return templateForWorkspace(id, corralId).definition;
}

/**
 * The role names in execution order, one entry per step. Roles that run at the same time (the
 * branches of one port) share a step; a role that runs again later is not repeated.
 */
export function roleSteps(definition: CorralDefinition): string[][] {
  const compiled = compileDefinition(definition);
  if (!compiled.ok) return [];
  const { plan } = compiled;
  const branchOf = new Map<string, string>();
  for (const step of Object.values(plan.steps))
    for (const [port, targets] of Object.entries(portsOf(step)))
      if (targets.length > 1)
        for (const target of targets) branchOf.set(target.nodeId, `${step.nodeId}:${port}`);
  const steps: { fork: string | null; names: string[] }[] = [];
  const seen = new Set<string>();
  for (const nodeId of plan.order) {
    const step = plan.steps[nodeId];
    if (step?.kind !== 'agent' || seen.has(step.roleId)) continue;
    seen.add(step.roleId);
    const name = definition.roles.find((role) => role.id === step.roleId)?.name ?? step.roleId;
    const fork = branchOf.get(nodeId) ?? null;
    const last = steps.at(-1);
    if (fork && last?.fork === fork) last.names.push(name);
    else steps.push({ fork, names: [name] });
  }
  return steps.map((step) => step.names);
}

function portsOf(step: PlanStep): Record<string, { nodeId: string }[]> {
  switch (step.kind) {
    case 'agent':
      return { out: step.next, error: step.error };
    case 'decision':
      return step.branches;
    case 'loop':
      return { body: step.body, next: step.next, exhausted: step.exhausted };
    case 'team':
      return { body: step.body, next: step.next };
    case 'join':
      return { out: step.next };
    case 'output':
      return {};
  }
}

export function templateCopyName(
  name: string,
  projectId: string,
  corrals: readonly Pick<CorralSummary, 'name' | 'projectId'>[],
): string {
  const names = new Set(
    corrals.filter((team) => team.projectId === projectId).map((team) => team.name),
  );
  let uniqueName = name;
  for (let suffix = 2; names.has(uniqueName); suffix++) uniqueName = `${name} (${suffix})`;
  return uniqueName;
}

/** Saves a new Corral from a template and returns its id, or an error message. */
export async function createFromTemplate(
  repository: CorralRepository,
  id: WorkspaceTemplateId,
  text: TemplateText,
  projectId?: string,
  copyName?: string,
): Promise<{ ok: true; corralId: string } | { ok: false; message: string }> {
  const suffix = globalThis.crypto.randomUUID().slice(0, 8);
  const draft = {
    definition: templateDefinition(id, `${id.replaceAll('-', '_')}_${suffix}`, text),
  };
  const name = copyName?.trim() || draft.definition.name;
  const uniqueName = templateCopyName(
    name,
    projectId ?? DEFAULT_PROJECT_ID,
    await repository.list(),
  );
  const result = await repository.save({
    ...draft,
    definition: {
      ...draft.definition,
      name: uniqueName,
    },
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
    templates: TemplateText;
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
      text.templates,
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
