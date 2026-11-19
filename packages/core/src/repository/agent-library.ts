import {
  type Clock,
  CreateLibraryAgent,
  canonicalJson,
  Identifier,
  LibraryAgent,
  LibraryAgentRole,
  UpdateLibraryAgent,
} from '@corral/contracts';
import { z } from 'zod';
import type { CorralRepository, KeyValueStore } from './index.ts';

export interface AgentLibrary {
  list(projectId: string): Promise<LibraryAgent[]>;
  get(projectId: string, agentId: string): Promise<LibraryAgent | null>;
  create(projectId: string, input: CreateLibraryAgent): Promise<AgentLibraryResult>;
  update(
    projectId: string,
    agentId: string,
    change: UpdateLibraryAgent,
  ): Promise<AgentLibraryResult>;
}

export type AgentLibraryResult =
  | { ok: true; agent: LibraryAgent }
  | {
      ok: false;
      error:
        | 'not_found'
        | 'revision_conflict'
        | 'operation_conflict'
        | 'invalid'
        | 'storage_unavailable';
      message: string;
    };

// Locally supplied optional settings can be explicitly undefined; on the wire these keys are absent.
function roleContent(role: LibraryAgentRole) {
  return canonicalJson(
    Object.fromEntries(Object.entries(role).filter(([, value]) => value !== undefined)),
  );
}

export function planAgentCreate(
  projectId: string,
  projectActive: boolean,
  original: LibraryAgent | null,
  input: CreateLibraryAgent,
  context: { now: string; newAgentId: () => string },
): AgentLibraryResult {
  const parsed = CreateLibraryAgent.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid', message: 'Invalid creation request.' };
  if (!projectActive) return { ok: false, error: 'not_found', message: 'No active project.' };
  const role = parsed.data.role;
  if (original) {
    return roleContent(original.role) === roleContent(role)
      ? { ok: true, agent: original }
      : { ok: false, error: 'operation_conflict', message: 'Creation operation already used.' };
  }
  return {
    ok: true,
    agent: {
      projectId,
      agentId: context.newAgentId(),
      revision: 1,
      role,
      createdAt: context.now,
      updatedAt: context.now,
      archivedAt: null,
    },
  };
}

export function planAgentUpdate(
  current: LibraryAgent | null,
  change: UpdateLibraryAgent,
  now: string,
): AgentLibraryResult {
  const parsed = UpdateLibraryAgent.safeParse(change);
  if (!parsed.success) return { ok: false, error: 'invalid', message: 'Invalid agent update.' };
  if (!current) return { ok: false, error: 'not_found', message: 'No such agent in this project.' };
  const { expectedRevision, role, archived } = parsed.data;
  if (expectedRevision !== current.revision) {
    return {
      ok: false,
      error: 'revision_conflict',
      message: 'The agent has changed. Reload first.',
    };
  }
  const changed = role !== undefined && roleContent(role) !== roleContent(current.role);
  const archivedAt =
    archived === undefined ? current.archivedAt : archived ? (current.archivedAt ?? now) : null;
  if (!changed && archivedAt === current.archivedAt) return { ok: true, agent: current };
  return {
    ok: true,
    agent: {
      ...current,
      ...(changed ? { role, revision: current.revision + 1 } : {}),
      archivedAt,
      updatedAt: now,
    },
  };
}

// One project key commits the agent and its creation receipt together. Keep the first role
// separately only after its content changes; reads expose current records, never receipts.
const StoredAgents = z.array(
  z.strictObject({
    operationId: Identifier,
    agent: LibraryAgent,
    creationRole: LibraryAgentRole.optional(),
  }),
);
type StoredAgents = z.infer<typeof StoredAgents>;
const projectKey = (projectId: string) => `corral:v1:agents:${projectId}`;

export function createKeyValueAgentLibrary(
  store: KeyValueStore,
  options: {
    clock: Clock;
    newAgentId: () => string;
    projects: Pick<CorralRepository, 'listProjects'>;
    /** Shared localStorage needs an exclusive read/plan/write across tabs; memory stores do not. */
    locks?: { request<T>(name: string, work: () => T | Promise<T>): Promise<T> };
  },
): AgentLibrary {
  function read(projectId: string): StoredAgents {
    try {
      const raw = store.getItem(projectKey(projectId));
      if (raw === null) return [];
      const entries = StoredAgents.parse(JSON.parse(raw));
      if (entries.every(({ agent }) => agent.projectId === projectId)) return entries;
    } catch {
      // Syntax and validation errors can contain private role text. Do not propagate them.
    }
    throw new Error('The saved agent library cannot be read.');
  }
  async function write(
    projectId: string,
    work: () => AgentLibraryResult | Promise<AgentLibraryResult>,
  ): Promise<AgentLibraryResult> {
    try {
      return options.locks
        ? await options.locks.request(projectKey(projectId), work)
        : await work();
    } catch {
      return { ok: false, error: 'storage_unavailable', message: 'Could not save the agent.' };
    }
  }
  return {
    async list(projectId) {
      return read(projectId)
        .map(({ agent }) => agent)
        .sort((a, b) => {
          if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
          return a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0;
        });
    },
    async get(projectId, agentId) {
      return read(projectId).find(({ agent }) => agent.agentId === agentId)?.agent ?? null;
    },
    create(projectId, input) {
      return write(projectId, async () => {
        const projects = await options.projects.listProjects();
        const active = projects.some((p) => p.projectId === projectId && p.archivedAt === null);
        const entries = read(projectId);
        const entry = entries.find((e) => e.operationId === input?.operationId);
        const original = entry
          ? {
              ...entry.agent,
              role: entry.creationRole ?? entry.agent.role,
              revision: 1,
              updatedAt: entry.agent.createdAt,
              archivedAt: null,
            }
          : null;
        const result = planAgentCreate(projectId, active, original, input, {
          now: options.clock.nowIso(),
          newAgentId: options.newAgentId,
        });
        if (result.ok && !entry) {
          entries.push({ agent: result.agent, operationId: input.operationId });
          store.setItem(projectKey(projectId), JSON.stringify(entries));
        }
        return result;
      });
    },
    update(projectId, agentId, change) {
      return write(projectId, () => {
        const entries = read(projectId);
        const entry = entries.find(({ agent }) => agent.agentId === agentId);
        const result = planAgentUpdate(entry?.agent ?? null, change, options.clock.nowIso());
        if (result.ok && entry && entry.agent !== result.agent) {
          if (result.agent.revision !== entry.agent.revision)
            entry.creationRole ??= entry.agent.role;
          entry.agent = result.agent;
          store.setItem(projectKey(projectId), JSON.stringify(entries));
        }
        return result;
      });
    },
  };
}
