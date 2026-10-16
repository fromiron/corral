import {
  CanvasLayout,
  type Clock,
  type CorralDefinition,
  CorralDefinitionDraft,
  type NodeLayout,
} from '@corral/contracts';
import { z } from 'zod';
import { canonicalJson } from '../canonical-json.ts';
import { definitionHash } from '../definition-hash.ts';

// Saved Corrals (C-009). Definition and layout are versioned separately: moving nodes bumps
// only layoutRevision; changing what runs bumps definitionRevision (CRL-CAN-002, INV-12).
// Work in progress may be saved: records hold the draft schema, runs compile the strict one.
// The browser uses this over localStorage until the local server replaces it (P2, PUT /corrals).

/** Projects group Corrals and their runs (CR-010); records from before them belong here. */
export const DEFAULT_PROJECT_ID = 'default';

export interface ProjectSummary {
  projectId: string;
  /** Empty only for the default project, which Studio names in the reader's language. */
  name: string;
  description: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** Hidden from the switcher, never deleted (CR-010). */
  archivedAt: string | null;
}

export interface ProjectChange {
  name?: string;
  description?: string;
  archived?: boolean;
  expectedRevision: number;
}

export type ProjectResult =
  | { ok: true; project: ProjectSummary }
  | {
      ok: false;
      error: 'not_found' | 'revision_conflict' | 'invalid' | 'storage_unavailable';
      message: string;
    };

export interface CorralRecord {
  corralId: string;
  projectId: string;
  name: string;
  definition: CorralDefinition;
  definitionRevision: number;
  definitionHash: string;
  layout: CanvasLayout;
  layoutRevision: number;
  updatedAt: string;
}

export interface CorralSummary {
  corralId: string;
  projectId: string;
  name: string;
  definitionRevision: number;
  layoutRevision: number;
  nodeCount: number;
  updatedAt: string;
}

export interface SaveRequest {
  definition: CorralDefinition;
  layout: { nodes: Record<string, NodeLayout>; viewport: CanvasLayout['viewport'] };
  /** null creates a new Corral; otherwise the revision this edit started from. */
  expectedDefinitionRevision: number | null;
  /** Where a new Corral goes (CR-010); the default project when absent. Ignored on edits. */
  projectId?: string;
}

export type SaveResult =
  | { ok: true; record: CorralRecord; changed: { definition: boolean; layout: boolean } }
  | {
      ok: false;
      error: 'revision_conflict' | 'not_found' | 'storage_unavailable';
      message: string;
    };

export interface CorralRepository {
  list(): Promise<CorralSummary[]>;
  get(corralId: string): Promise<CorralRecord | null>;
  save(request: SaveRequest): Promise<SaveResult>;
  duplicate(corralId: string, name: string): Promise<SaveResult>;
  remove(corralId: string): Promise<void>;
  /** The default project first, then the rest by name; archived ones included (CR-010). */
  listProjects(): Promise<ProjectSummary[]>;
  createProject(input: { name: string; description?: string }): Promise<ProjectResult>;
  updateProject(projectId: string, change: ProjectChange): Promise<ProjectResult>;
  /** Moves a Corral; runs already started stay in the project they started in. */
  moveCorral(corralId: string, projectId: string): Promise<SaveResult>;
}

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;

/** The default project as it exists before anyone renames it. */
export function defaultProject(now: string): ProjectSummary {
  return {
    projectId: DEFAULT_PROJECT_ID,
    name: '',
    description: '',
    revision: 1,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}

function checkProjectText(name: string | undefined, description: string | undefined) {
  if (name !== undefined && (name.length === 0 || name.length > NAME_MAX))
    return `A project name has 1 to ${NAME_MAX} characters.`;
  if (description !== undefined && description.length > DESCRIPTION_MAX)
    return `A project description has at most ${DESCRIPTION_MAX} characters.`;
  return null;
}

/** A new project, or why not (CR-010). Names are trimmed; the same name may be used twice. */
export function planProjectCreate(
  input: { name: string; description?: string },
  context: { now: string; projectId: string },
): ProjectResult {
  const name = input.name.trim();
  const description = (input.description ?? '').trim();
  const problem = checkProjectText(name, description);
  if (problem) return { ok: false, error: 'invalid', message: problem };
  return {
    ok: true,
    project: {
      projectId: context.projectId,
      name,
      description,
      revision: 1,
      createdAt: context.now,
      updatedAt: context.now,
      archivedAt: null,
    },
  };
}

export function planProjectUpdate(
  current: ProjectSummary | null,
  projectId: string,
  change: ProjectChange,
  now: string,
): ProjectResult {
  if (!current)
    return { ok: false, error: 'not_found', message: `Project ${projectId} does not exist.` };
  if (current.revision !== change.expectedRevision)
    return {
      ok: false,
      error: 'revision_conflict',
      message: `This project was changed elsewhere (revision ${current.revision}). Reload first.`,
    };
  if (change.archived && current.projectId === DEFAULT_PROJECT_ID)
    return { ok: false, error: 'invalid', message: 'The default project cannot be archived.' };
  const name = change.name?.trim();
  const description = change.description?.trim();
  const problem = checkProjectText(name, description);
  if (problem) return { ok: false, error: 'invalid', message: problem };
  return {
    ok: true,
    project: {
      ...current,
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(change.archived === undefined
        ? {}
        : { archivedAt: change.archived ? (current.archivedAt ?? now) : null }),
      revision: current.revision + 1,
      updatedAt: now,
    },
  };
}

/** Corrals are made in, and moved to, existing projects that are not archived. */
export function projectRefusal(
  project: ProjectSummary | null | undefined,
  projectId: string,
): SaveResult | null {
  if (project && !project.archivedAt) return null;
  return {
    ok: false,
    error: 'not_found',
    message: project ? `Project ${projectId} is archived.` : `Project ${projectId} does not exist.`,
  };
}

/** The same Corral in another project; revisions do not change (CR-010). */
export function planMove(
  current: CorralRecord | null,
  corralId: string,
  projectId: string,
  now: string,
): SaveResult {
  if (!current)
    return { ok: false, error: 'not_found', message: `Corral ${corralId} does not exist.` };
  return {
    ok: true,
    record: { ...current, projectId, updatedAt: now },
    changed: { definition: false, layout: false },
  };
}

/** Default first, then by name, then by id. */
export function sortProjects(projects: ProjectSummary[]): ProjectSummary[] {
  return [...projects].sort((a, b) =>
    a.projectId === DEFAULT_PROJECT_ID
      ? -1
      : b.projectId === DEFAULT_PROJECT_ID
        ? 1
        : a.name.localeCompare(b.name) || a.projectId.localeCompare(b.projectId),
  );
}

/** The subset of Web Storage this repository needs; tests pass a Map-backed store. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = 'corral:v1:';
const INDEX_KEY = `${PREFIX}index`;
const PROJECTS_KEY = `${PREFIX}projects`;
const recordKey = (corralId: string) => `${PREFIX}corral:${corralId}`;

const StoredRecord = z.strictObject({
  corralId: z.string().min(1),
  // Records saved before projects (CR-010) have none: they belong to the default project.
  projectId: z.string().min(1).default(DEFAULT_PROJECT_ID),
  name: z.string(),
  definition: CorralDefinitionDraft,
  definitionRevision: z.int().min(1),
  definitionHash: z.string(),
  layout: CanvasLayout,
  layoutRevision: z.int().min(1),
  updatedAt: z.string(),
});

/** Validates a stored record; storage adapters call it so bad rows fail loudly. */
export function parseCorralRecord(value: unknown, corralId: string): CorralRecord {
  const parsed = StoredRecord.safeParse(value);
  if (!parsed.success) throw new Error(`Saved Corral ${corralId} cannot be read.`);
  return parsed.data;
}

/**
 * The revision rules every repository applies (CRL-CAN-002): what a save produces from the
 * current record, or why it is refused. Pure, so every storage adapter means the same thing.
 */
export function planSave(
  current: CorralRecord | null,
  request: SaveRequest,
  context: { now: string; newCorralId: () => string },
): SaveResult {
  if (request.expectedDefinitionRevision === null) {
    // A new Corral always gets its own id, even when imported from a file.
    return planCreate(
      request.definition,
      request.layout,
      context.newCorralId(),
      context.now,
      request.projectId ?? DEFAULT_PROJECT_ID,
    );
  }
  if (!current)
    return {
      ok: false,
      error: 'not_found',
      message: `Corral ${request.definition.id} does not exist.`,
    };
  if (current.definitionRevision !== request.expectedDefinitionRevision) {
    return {
      ok: false,
      error: 'revision_conflict',
      message: `This Corral was saved elsewhere (revision ${current.definitionRevision}). Reload before saving.`,
    };
  }
  const hash = definitionHash(request.definition);
  const definitionChanged = hash !== current.definitionHash;
  const layoutChanged =
    canonicalJson({ nodes: request.layout.nodes, viewport: request.layout.viewport }) !==
    canonicalJson({ nodes: current.layout.nodes, viewport: current.layout.viewport });
  if (!definitionChanged && !layoutChanged) {
    return { ok: true, record: current, changed: { definition: false, layout: false } };
  }
  const definitionRevision = current.definitionRevision + (definitionChanged ? 1 : 0);
  const layoutRevision = current.layoutRevision + (layoutChanged ? 1 : 0);
  const record: CorralRecord = {
    ...current,
    name: request.definition.name,
    definition: request.definition,
    definitionRevision,
    definitionHash: hash,
    layout: { ...current.layout, ...request.layout, layoutRevision },
    layoutRevision,
    updatedAt: context.now,
  };
  return { ok: true, record, changed: { definition: definitionChanged, layout: layoutChanged } };
}

/** A copy under a new id, starting again at revision 1. */
export function planDuplicate(
  source: CorralRecord | null,
  corralId: string,
  name: string,
  context: { now: string; newCorralId: () => string },
): SaveResult {
  if (!source)
    return { ok: false, error: 'not_found', message: `Corral ${corralId} does not exist.` };
  return planCreate(
    { ...source.definition, name },
    { nodes: source.layout.nodes, viewport: source.layout.viewport },
    context.newCorralId(),
    context.now,
    source.projectId,
  );
}

function planCreate(
  definition: CorralDefinition,
  layout: SaveRequest['layout'],
  corralId: string,
  now: string,
  projectId: string,
): SaveResult {
  const owned = { ...definition, id: corralId };
  const record: CorralRecord = {
    corralId,
    projectId,
    name: owned.name,
    definition: owned,
    definitionRevision: 1,
    definitionHash: definitionHash(owned),
    layout: { schemaVersion: '0.1', corralId, layoutRevision: 1, ...layout },
    layoutRevision: 1,
    updatedAt: now,
  };
  return { ok: true, record, changed: { definition: true, layout: true } };
}

const StoredProject = z.strictObject({
  projectId: z.string().min(1),
  name: z.string(),
  description: z.string(),
  revision: z.int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});

// Browsers and Node 24 both have Web Crypto; core does not compile against the DOM types.
const newProjectIdDefault = () =>
  `project_${(globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID().slice(0, 8)}`;

export function createKeyValueCorralRepository(
  store: KeyValueStore,
  options: { clock: Clock; newCorralId: () => string; newProjectId?: () => string },
): CorralRepository {
  const newProjectId = options.newProjectId ?? newProjectIdDefault;
  // Projects live in one key; the default project exists even before anything is written.
  const readProjects = (): ProjectSummary[] => {
    const raw = store.getItem(PROJECTS_KEY);
    const parsed = raw === null ? [] : z.array(StoredProject).safeParse(safeJson(raw)).data;
    if (!parsed) throw new Error('The saved project list cannot be read.');
    return parsed.some((p) => p.projectId === DEFAULT_PROJECT_ID)
      ? parsed
      : [defaultProject(options.clock.nowIso()), ...parsed];
  };
  const writeProject = (project: ProjectSummary): ProjectResult => {
    try {
      const others = readProjects().filter((p) => p.projectId !== project.projectId);
      store.setItem(PROJECTS_KEY, JSON.stringify([...others, project]));
      return { ok: true, project };
    } catch (error) {
      return {
        ok: false,
        error: 'storage_unavailable',
        message: `Could not save: ${String(error)}`,
      };
    }
  };
  const findProject = (projectId: string) =>
    readProjects().find((p) => p.projectId === projectId) ?? null;
  const readIndex = (): string[] => {
    const raw = store.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed = z.array(z.string()).safeParse(safeJson(raw));
    if (!parsed.success) throw new Error('The saved Corral list cannot be read.');
    return parsed.data;
  };
  const read = (corralId: string): CorralRecord | null => {
    const raw = store.getItem(recordKey(corralId));
    return raw === null ? null : parseCorralRecord(safeJson(raw), corralId);
  };
  const write = (record: CorralRecord): SaveResult | null => {
    try {
      store.setItem(recordKey(record.corralId), JSON.stringify(record));
      const index = readIndex();
      if (!index.includes(record.corralId))
        store.setItem(INDEX_KEY, JSON.stringify([...index, record.corralId]));
      return null;
    } catch (error) {
      return {
        ok: false,
        error: 'storage_unavailable',
        message: `Could not save: ${String(error)}`,
      };
    }
  };

  const context = () => ({ now: options.clock.nowIso(), newCorralId: options.newCorralId });
  const persist = (result: SaveResult): SaveResult =>
    result.ok && (result.changed.definition || result.changed.layout)
      ? (write(result.record) ?? result)
      : result;

  return {
    async list() {
      return readIndex()
        .map(read)
        .filter((r): r is CorralRecord => r !== null)
        .map((r) => ({
          corralId: r.corralId,
          projectId: r.projectId,
          name: r.name,
          definitionRevision: r.definitionRevision,
          layoutRevision: r.layoutRevision,
          nodeCount: r.definition.nodes.length,
          updatedAt: r.updatedAt,
        }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
    },

    async get(corralId) {
      return read(corralId);
    },

    async save(request) {
      if (request.expectedDefinitionRevision === null) {
        const projectId = request.projectId ?? DEFAULT_PROJECT_ID;
        const refused = projectRefusal(findProject(projectId), projectId);
        if (refused) return refused;
      }
      const current =
        request.expectedDefinitionRevision === null ? null : read(request.definition.id);
      return persist(planSave(current, request, context()));
    },

    async duplicate(corralId, name) {
      return persist(planDuplicate(read(corralId), corralId, name, context()));
    },

    async remove(corralId) {
      store.removeItem(recordKey(corralId));
      store.setItem(INDEX_KEY, JSON.stringify(readIndex().filter((id) => id !== corralId)));
    },

    async listProjects() {
      return sortProjects(readProjects());
    },

    async createProject(input) {
      const planned = planProjectCreate(input, {
        now: options.clock.nowIso(),
        projectId: newProjectId(),
      });
      return planned.ok ? writeProject(planned.project) : planned;
    },

    async updateProject(projectId, change) {
      const planned = planProjectUpdate(
        findProject(projectId),
        projectId,
        change,
        options.clock.nowIso(),
      );
      return planned.ok ? writeProject(planned.project) : planned;
    },

    async moveCorral(corralId, projectId) {
      const refused = projectRefusal(findProject(projectId), projectId);
      if (refused) return refused;
      const moved = planMove(read(corralId), corralId, projectId, options.clock.nowIso());
      return moved.ok ? (write(moved.record) ?? moved) : moved;
    },
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
