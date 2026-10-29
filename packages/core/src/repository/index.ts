import {
  AutoModelChoice,
  AutoReasoning,
  AutoRoute,
  AutoRouteLevel,
  CanvasLayout,
  type Clock,
  CommandError,
  type CorralDefinition,
  CorralDefinitionDraft,
  HarnessBindingRef,
  type ImageAttachment,
  ImageAttachments,
  MeetingConfig,
  MeetingHandoffOrigin,
  MeetingState,
  type NodeLayout,
  PermissionMode,
  RunInput,
  type TextAttachment,
} from '@corral/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';
import { validTextAttachments } from '../attachments.ts';
import { canonicalJson } from '../canonical-json.ts';
import { definitionHash } from '../definition-hash.ts';

// Saved Corrals. Definition and layout are versioned separately: moving nodes bumps
// only layoutRevision; changing what runs bumps definitionRevision.
// Work in progress may be saved: records hold the draft schema, runs compile the strict one.
// The browser uses this over localStorage until the local server replaces it (P2, PUT /corrals).

/** Projects group Corrals and their runs; records from before them belong here. */
export const DEFAULT_PROJECT_ID = 'default';

export interface ProjectSummary {
  projectId: string;
  /** Empty only for the default project, which Studio names in the reader's language. */
  name: string;
  description: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** Hidden from the switcher, never deleted. */
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

/** What a person asked for in a session. */
export type SessionIntent = 'next' | 'queue' | 'steer' | 'explain';
export type SessionEntryState =
  | 'started'
  | 'queued'
  | 'sent'
  | 'refused'
  | 'undelivered'
  | 'dismissed';

export interface SessionEntry {
  /** A handoff can only be launched through its pinned receipt, never generic entry retry. */
  meetingHandoff?: MeetingHandoffOrigin;
  harness?: HarnessBindingRef;
  permissionMode?: PermissionMode;
  images?: ImageAttachment[];
  attachments?: TextAttachment[];
  taskScope?: RunInput['taskScope'];
  verificationScope?: RunInput['verificationScope'];
  entryId: string;
  intent: SessionIntent;
  /** What the person wrote; never changed once saved. */
  text: string;
  createdAt: string;
  state: SessionEntryState;
  /** The run it started (next, explain) or went to (steer). */
  runId: string | null;
  executionId: string | null;
  /** Why it was refused or not delivered, in the runtime's words. */
  detail: string | null;
  refusal?: CommandError | null;
  /** The command it was sent as, so its receipt and Reins delivery can be looked up. */
  commandId?: string | null;
  /** The template an auto request ran with; absent for a chosen team. */
  auto?: SessionEntryAuto | null;
}

export const SessionEntryAuto = AutoRoute.pick({
  harness: true,
  template: true,
  source: true,
  reason: true,
  modelProfile: true,
  fallback: true,
})
  // Older entries only saved the template and chosen level.
  .partial({ reason: true, modelProfile: true })
  .extend({
    permissionMode: PermissionMode.optional(),
    reasoning: AutoRouteLevel.optional(),
    requestedReasoning: AutoReasoning.optional(),
    reasoningSource: z.enum(['model', 'local', 'fallback']).optional(),
  });
export type SessionEntryAuto = z.infer<typeof SessionEntryAuto>;

export interface SessionEntryChange {
  state: SessionEntryState;
  runId?: string | null;
  detail?: string | null;
  refusal?: CommandError | null;
  auto?: SessionEntryAuto | null;
}

export interface WorkSession {
  sessionId: string;
  projectId: string;
  /** The team follow-ups run with; null means auto mode. */
  corralId: string | null;
  /** The model and reasoning auto mode uses; null until chosen. */
  auto: AutoModelChoice | null;
  title: string;
  /** True only until the first request names a session explicitly created without a user title. */
  autoTitle?: boolean;
  objective: string;
  pinned: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  entries: SessionEntry[];
  /** present only for a meeting; changed only by the meeting service. */
  meeting?: MeetingState;
}

export interface SessionChange {
  title?: string;
  objective?: string;
  corralId?: string | null;
  auto?: AutoModelChoice | null;
  pinned?: boolean;
  archived?: boolean;
  /** the meeting service's next state; a work session cannot become a meeting. */
  meeting?: MeetingState;
  expectedRevision: number;
}

export type SessionResult =
  | { ok: true; session: WorkSession }
  | {
      ok: false;
      error: 'not_found' | 'revision_conflict' | 'invalid' | 'storage_unavailable';
      message: string;
    };

export interface NewSessionEntry {
  meetingHandoff?: MeetingHandoffOrigin;
  harness?: HarnessBindingRef;
  permissionMode?: PermissionMode;
  images?: ImageAttachment[];
  attachments?: TextAttachment[];
  taskScope?: RunInput['taskScope'];
  verificationScope?: RunInput['verificationScope'];
  intent: SessionIntent;
  text: string;
  state: SessionEntryState;
  runId?: string | null;
  executionId?: string | null;
  detail?: string | null;
  refusal?: CommandError | null;
  commandId?: string | null;
  auto?: SessionEntryAuto | null;
}

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
  /** Where a new Corral goes; the default project when absent. Ignored on edits. */
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
  /** The default project first, then the rest by name; archived ones included. */
  listProjects(): Promise<ProjectSummary[]>;
  createProject(input: { name: string; description?: string }): Promise<ProjectResult>;
  updateProject(projectId: string, change: ProjectChange): Promise<ProjectResult>;
  /** Moves a Corral; runs already started stay in the project they started in. */
  moveCorral(corralId: string, projectId: string): Promise<SaveResult>;
  /** Pinned first, then most recently active. */
  listSessions(projectId: string): Promise<WorkSession[]>;
  getSession(sessionId: string): Promise<WorkSession | null>;
  createSession(input: {
    projectId: string;
    title: string;
    autoTitle?: boolean;
    objective?: string;
    corralId?: string | null;
    /** creates a meeting with these participants. */
    meeting?: MeetingConfig;
  }): Promise<SessionResult>;
  updateSession(sessionId: string, change: SessionChange): Promise<SessionResult>;
  addSessionEntry(sessionId: string, entry: NewSessionEntry): Promise<SessionResult>;
  /** Only the state, run and detail of an entry change; its text never does. */
  updateSessionEntry(
    sessionId: string,
    entryId: string,
    change: SessionEntryChange,
  ): Promise<SessionResult>;
}

const TITLE_MAX = 120;
const ENTRY_MAX = 20_000;
const ENTRIES_MAX = 1_000;

export function planSessionCreate(
  input: {
    projectId: string;
    title: string;
    autoTitle?: boolean;
    objective?: string;
    corralId?: string | null;
    meeting?: MeetingConfig;
  },
  context: { now: string; sessionId: string },
): SessionResult {
  const objective = (input.objective ?? '').trim();
  // A session may start from its purpose alone; the title is then its first line.
  const title = (input.title.trim() || objective.split('\n')[0]?.slice(0, 60) || '').trim();
  if (!title || title.length > TITLE_MAX)
    return {
      ok: false,
      error: 'invalid',
      message: `A session title has 1 to ${TITLE_MAX} characters.`,
    };
  if (objective.length > ENTRY_MAX)
    return { ok: false, error: 'invalid', message: 'The session purpose is too long.' };
  const meeting = input.meeting === undefined ? undefined : MeetingConfig.safeParse(input.meeting);
  if (meeting && !meeting.success)
    return { ok: false, error: 'invalid', message: 'The meeting participants are not valid.' };
  if (meeting && input.corralId)
    return { ok: false, error: 'invalid', message: 'A meeting does not run a chosen team.' };
  return {
    ok: true,
    session: {
      sessionId: context.sessionId,
      projectId: input.projectId,
      corralId: input.corralId ?? null,
      auto: null,
      title,
      autoTitle: input.autoTitle === true,
      objective,
      pinned: false,
      revision: 1,
      createdAt: context.now,
      updatedAt: context.now,
      archivedAt: null,
      entries: [],
      ...(meeting ? { meeting: { config: meeting.data, rounds: [], queued: null } } : {}),
    },
  };
}

export function planSessionUpdate(
  current: WorkSession | null,
  sessionId: string,
  change: SessionChange,
  now: string,
): SessionResult {
  if (!current)
    return { ok: false, error: 'not_found', message: `Session ${sessionId} does not exist.` };
  if (current.revision !== change.expectedRevision)
    return {
      ok: false,
      error: 'revision_conflict',
      message: `This session was changed elsewhere (revision ${current.revision}). Reload first.`,
    };
  if (change.auto && !AutoModelChoice.safeParse(change.auto).success)
    return { ok: false, error: 'invalid', message: 'The auto model choice is not valid.' };
  if (
    change.meeting !== undefined &&
    (!current.meeting || !MeetingState.safeParse(change.meeting).success)
  )
    return { ok: false, error: 'invalid', message: 'Only a meeting keeps a valid meeting state.' };
  if (current.meeting && change.corralId)
    return { ok: false, error: 'invalid', message: 'A meeting does not run a chosen team.' };
  const title = change.title?.trim();
  if (title !== undefined && (!title || title.length > TITLE_MAX))
    return {
      ok: false,
      error: 'invalid',
      message: `A session title has 1 to ${TITLE_MAX} characters.`,
    };
  const pinOnly =
    change.pinned !== undefined &&
    Object.entries(change).every(
      ([key, value]) => value === undefined || key === 'pinned' || key === 'expectedRevision',
    );
  return {
    ok: true,
    session: {
      ...current,
      ...(title !== undefined ? { title, autoTitle: false } : {}),
      ...(change.objective !== undefined ? { objective: change.objective.trim() } : {}),
      ...(change.corralId !== undefined ? { corralId: change.corralId } : {}),
      ...(change.auto !== undefined ? { auto: change.auto } : {}),
      ...(change.pinned !== undefined ? { pinned: change.pinned } : {}),
      ...(change.meeting !== undefined ? { meeting: MeetingState.parse(change.meeting) } : {}),
      ...(change.archived === undefined
        ? {}
        : { archivedAt: change.archived ? (current.archivedAt ?? now) : null }),
      revision: current.revision + 1,
      updatedAt: pinOnly ? current.updatedAt : now,
    },
  };
}

/** A new entry at the end; entries are not revision-checked, they only append. */
export function planSessionEntry(
  current: WorkSession | null,
  sessionId: string,
  entry: NewSessionEntry,
  context: { now: string; entryId: string },
): SessionResult {
  if (!current)
    return { ok: false, error: 'not_found', message: `Session ${sessionId} does not exist.` };
  if (current.meeting)
    return { ok: false, error: 'invalid', message: 'A meeting takes messages through its rounds.' };
  if (
    entry.meetingHandoff &&
    (!MeetingHandoffOrigin.safeParse(entry.meetingHandoff).success || entry.intent !== 'next')
  )
    return {
      ok: false,
      error: 'invalid',
      message: 'A handoff requires a valid source and next intent.',
    };
  if (
    entry.harness !== undefined &&
    (!HarnessBindingRef.safeParse(entry.harness).success ||
      !['next', 'queue'].includes(entry.intent))
  )
    return {
      ok: false,
      error: 'invalid',
      message: 'work style requires a next request and a pinned revision',
    };
  if (
    entry.permissionMode !== undefined &&
    (!PermissionMode.safeParse(entry.permissionMode).success ||
      !['next', 'queue'].includes(entry.intent))
  )
    return { ok: false, error: 'invalid', message: 'permission mode requires a next request' };
  if (
    entry.images &&
    (!ImageAttachments.safeParse(entry.images).success || entry.intent !== 'next')
  )
    return {
      ok: false,
      error: 'invalid',
      message: 'images require valid immutable references and next intent',
    };
  if (
    entry.attachments &&
    (!validTextAttachments(entry.attachments) || !['next', 'queue'].includes(entry.intent))
  )
    return {
      ok: false,
      error: 'invalid',
      message: 'text attachments require valid immutable content and next or queue intent',
    };
  if (
    !RunInput.pick({ taskScope: true, verificationScope: true }).safeParse({
      taskScope: entry.taskScope,
      verificationScope: entry.verificationScope,
    }).success
  )
    return { ok: false, error: 'invalid', message: 'invalid request scope' };
  // Ultra was removed; a request naming it is refused, not run without it.
  if ('qualityPreset' in entry || 'ultra' in entry)
    return {
      ok: false,
      error: 'invalid',
      message: 'Ultra was removed; a request cannot choose it',
    };
  if (entry.refusal != null && !CommandError.safeParse(entry.refusal).success)
    return { ok: false, error: 'invalid', message: 'invalid refusal diagnostics' };
  const text = entry.text.trim();
  if (!text || text.length > ENTRY_MAX)
    return { ok: false, error: 'invalid', message: `A request has 1 to ${ENTRY_MAX} characters.` };
  if (entry.commandId) {
    const previous = current.entries.find((value) => value.commandId === entry.commandId);
    if (previous) {
      const identity = (value: NewSessionEntry) =>
        canonicalJson({
          intent: value.intent,
          text: value.text.trim(),
          runId: value.runId ?? null,
          executionId: value.executionId ?? null,
          attachments: value.attachments ?? [],
          images: value.images ?? [],
          ...(value.permissionMode ? { permissionMode: value.permissionMode } : {}),
          ...(value.harness ? { harness: value.harness } : {}),
          taskScope: value.taskScope ?? null,
          verificationScope: value.verificationScope ?? null,
          meetingHandoff: value.meetingHandoff ?? null,
        });
      return identity(previous) === identity(entry)
        ? { ok: true, session: current }
        : {
            ok: false,
            error: 'invalid',
            message: 'this request entry was already recorded with different content',
          };
    }
  }
  if (current.entries.length >= ENTRIES_MAX)
    return { ok: false, error: 'invalid', message: 'This session is full; start a new one.' };
  const nameFromRequest =
    current.autoTitle && (entry.intent === 'next' || entry.intent === 'queue');
  return {
    ok: true,
    session: {
      ...current,
      ...(nameFromRequest
        ? {
            title: Array.from(text.split('\n')[0] ?? text)
              .slice(0, 60)
              .join('')
              .trim(),
            autoTitle: false,
            revision: current.revision + 1,
          }
        : {}),
      updatedAt: context.now,
      entries: [
        ...current.entries,
        {
          entryId: context.entryId,
          intent: entry.intent,
          text,
          createdAt: context.now,
          state: entry.state,
          runId: entry.runId ?? null,
          executionId: entry.executionId ?? null,
          detail: entry.detail ?? null,
          ...(entry.refusal ? { refusal: CommandError.parse(entry.refusal) } : {}),
          commandId: entry.commandId ?? null,
          ...(entry.meetingHandoff
            ? { meetingHandoff: MeetingHandoffOrigin.parse(entry.meetingHandoff) }
            : {}),
          ...(entry.auto ? { auto: entry.auto } : {}),
          ...(entry.permissionMode ? { permissionMode: entry.permissionMode } : {}),
          ...(entry.harness ? { harness: HarnessBindingRef.parse(entry.harness) } : {}),
          ...(entry.taskScope ? { taskScope: entry.taskScope } : {}),
          ...(entry.verificationScope ? { verificationScope: entry.verificationScope } : {}),
          ...(entry.attachments?.length
            ? { attachments: JSON.parse(canonicalJson(entry.attachments)) as TextAttachment[] }
            : {}),
          ...(entry.images?.length
            ? { images: JSON.parse(canonicalJson(entry.images)) as ImageAttachment[] }
            : {}),
        },
      ],
    },
  };
}

/** A saved queue item has one start identity across tabs; model/history changes cannot clone it. */
export function queuedSessionCommandId(sessionId: string, entry: SessionEntry): string {
  return (
    entry.commandId ??
    `queue_${bytesToHex(
      sha256(
        utf8ToBytes(
          canonicalJson({
            sessionId,
            entryId: entry.entryId,
            text: entry.text,
            attachments: entry.attachments ?? [],
            permissionMode: entry.permissionMode ?? null,
          }),
        ),
      ),
    )}`
  );
}

export function planSessionEntryUpdate(
  current: WorkSession | null,
  sessionId: string,
  entryId: string,
  change: SessionEntryChange,
  now: string,
): SessionResult {
  if (!current)
    return { ok: false, error: 'not_found', message: `Session ${sessionId} does not exist.` };
  if (change.refusal != null && !CommandError.safeParse(change.refusal).success)
    return { ok: false, error: 'invalid', message: 'invalid refusal diagnostics' };
  const entry = current.entries.find((e) => e.entryId === entryId);
  if (!entry)
    return { ok: false, error: 'not_found', message: `Session ${sessionId} has no ${entryId}.` };
  if (
    entry.intent === 'queue' &&
    entry.state !== 'queued' &&
    !(entry.state !== 'started' && change.state === 'started' && change.runId)
  ) {
    const same = (['state', 'runId', 'detail', 'refusal', 'auto'] as const).every(
      (key) =>
        change[key] === undefined ||
        canonicalJson(change[key] ?? null) === canonicalJson(entry[key] ?? null),
    );
    return same
      ? { ok: true, session: current }
      : {
          ok: false,
          error: 'revision_conflict',
          message: 'The queued request already has a different outcome. Refresh the session.',
        };
  }
  return {
    ok: true,
    session: {
      ...current,
      updatedAt: now,
      entries: current.entries.map((e) =>
        e.entryId === entryId
          ? {
              ...e,
              state: change.state,
              ...(change.runId !== undefined ? { runId: change.runId } : {}),
              ...(change.detail !== undefined ? { detail: change.detail } : {}),
              ...(change.refusal !== undefined
                ? { refusal: change.refusal ? CommandError.parse(change.refusal) : null }
                : {}),
              ...(change.auto !== undefined ? { auto: change.auto } : {}),
            }
          : e,
      ),
    },
  };
}

export function sortSessions(sessions: WorkSession[]): WorkSession[] {
  return [...sessions].sort(
    (a, b) =>
      Number(b.pinned) - Number(a.pinned) ||
      b.updatedAt.localeCompare(a.updatedAt) ||
      a.sessionId.localeCompare(b.sessionId),
  );
}

const randomId = (prefix: string) =>
  `${prefix}_${(globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID().slice(0, 8)}`;

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

/** A new project, or why not. Names are trimmed; the same name may be used twice. */
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

/** The same Corral in another project; revisions do not change. */
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
const SESSIONS_KEY = `${PREFIX}sessions`;
const recordKey = (corralId: string) => `${PREFIX}corral:${corralId}`;

const StoredRecord = z.strictObject({
  corralId: z.string().min(1),
  // Records saved before projects have none: they belong to the default project.
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
 * The revision rules every repository applies: what a save produces from the
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
  options: {
    clock: Clock;
    newCorralId: () => string;
    newProjectId?: () => string;
    newSessionId?: () => string;
  },
): CorralRepository {
  const newSessionId = options.newSessionId ?? (() => randomId('session'));
  const readSessions = (): WorkSession[] => {
    const raw = store.getItem(SESSIONS_KEY);
    if (raw === null) return [];
    const parsed = safeJson(raw);
    if (!Array.isArray(parsed)) throw new Error('The saved session list cannot be read.');
    // Sessions saved before auto mode have no choice yet.
    return (parsed as WorkSession[]).map((x) => ({ ...x, auto: x.auto ?? null }));
  };
  const findSession = (sessionId: string) =>
    readSessions().find((x) => x.sessionId === sessionId) ?? null;
  const writeSession = (result: SessionResult): SessionResult => {
    if (!result.ok) return result;
    try {
      const others = readSessions().filter((x) => x.sessionId !== result.session.sessionId);
      store.setItem(SESSIONS_KEY, JSON.stringify([...others, result.session]));
      return result;
    } catch (error) {
      return {
        ok: false,
        error: 'storage_unavailable',
        message: `Could not save: ${String(error)}`,
      };
    }
  };
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

  // Write the backup/receipt first: an interrupted browser migration can resume without losing revision 1.
  for (const id of readIndex()) {
    const before = read(id);
    if (!before || before.definition.executionPolicy) continue;
    const result = planSave(
      before,
      {
        definition: { ...before.definition, executionPolicy: { version: 2 } },
        layout: before.layout,
        expectedDefinitionRevision: before.definitionRevision,
      },
      context(),
    );
    if (!result.ok) throw new Error(result.message);
    const key = `${PREFIX}cr052:${id}:${before.definitionRevision}`;
    if (store.getItem(key) === null)
      store.setItem(
        key,
        JSON.stringify({
          before,
          afterRevision: result.record.definitionRevision,
          afterHash: result.record.definitionHash,
        }),
      );
    const written = persist(result);
    if (!written.ok) throw new Error(written.message);
  }

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

    async listSessions(projectId) {
      return sortSessions(readSessions().filter((x) => x.projectId === projectId));
    },

    async getSession(sessionId) {
      return findSession(sessionId);
    },

    async createSession(input) {
      const refused = projectRefusal(findProject(input.projectId), input.projectId);
      if (refused && !refused.ok)
        return { ok: false, error: 'not_found', message: refused.message };
      return writeSession(
        planSessionCreate(input, { now: options.clock.nowIso(), sessionId: newSessionId() }),
      );
    },

    async updateSession(sessionId, change) {
      return writeSession(
        planSessionUpdate(findSession(sessionId), sessionId, change, options.clock.nowIso()),
      );
    },

    async addSessionEntry(sessionId, entry) {
      return writeSession(
        planSessionEntry(findSession(sessionId), sessionId, entry, {
          now: options.clock.nowIso(),
          entryId: randomId('entry'),
        }),
      );
    },

    async updateSessionEntry(sessionId, entryId, change) {
      return writeSession(
        planSessionEntryUpdate(
          findSession(sessionId),
          sessionId,
          entryId,
          change,
          options.clock.nowIso(),
        ),
      );
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
