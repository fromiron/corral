import {
  CorralDefinition,
  EffectiveHarnessSnapshot,
  Identifier,
  ModelProfileSnapshot,
  RunEvent,
  RunStatus,
} from '@corral/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';
import { canonicalJson } from './canonical-json.ts';
import { definitionHash } from './definition-hash.ts';
import { applyEvent, emptyProjection } from './projection.ts';
import type { RunStore } from './store/run-store.ts';

const Snapshot = z.strictObject({
  definition: CorralDefinition,
  definitionHash: z.string().regex(/^[0-9a-f]{64}$/),
  source: z
    .strictObject({ corralId: Identifier, definitionRevision: z.int().positive() })
    .nullable(),
  criteriaVersionId: Identifier,
  mode: z.enum(['mock', 'live']),
  models: z.record(Identifier, ModelProfileSnapshot),
  harnesses: z.record(Identifier, EffectiveHarnessSnapshot).optional(),
  startedAt: z.iso.datetime(),
});
const PublicArchive = z.strictObject({
  format: z.literal('corral-history'),
  formatVersion: z.literal(1),
  visibility: z.literal('public'),
  status: RunStatus,
  events: z
    .array(
      z.strictObject({
        runSeq: z.int().positive(),
        type: z.enum(RunEvent.options.map((event) => event.shape.type.value)),
        recordedAt: z.iso.datetime(),
      }),
    )
    .max(1_000_000),
  counts: z.strictObject({
    executions: z.int().nonnegative(),
    artifacts: z.int().nonnegative(),
    modelCalls: z.int().nonnegative(),
  }),
});
const PrivateArchive = z.strictObject({
  format: z.literal('corral-history'),
  formatVersion: z.literal(1),
  visibility: z.literal('private'),
  runId: Identifier,
  lastSeq: z.int().positive(),
  snapshot: Snapshot,
  events: z.array(RunEvent).min(1).max(1_000_000),
  artifacts: z.record(Identifier, z.string()),
  bodyHashes: z.record(Identifier, z.string().regex(/^[0-9a-f]{64}$/)),
});
const Archive = z.discriminatedUnion('visibility', [PublicArchive, PrivateArchive]);
export type RunArchive = z.infer<typeof Archive>;

/** Public archives deliberately allowlist metadata: new payload fields stay private by default. */
export function exportRunArchive(
  store: RunStore,
  runId: string,
  options: { privateTranscript?: boolean } = {},
): RunArchive {
  return store.transaction(() => {
    const run = store.getRun(runId);
    if (!run) throw new Error('no such run');
    const events = store.readEvents(runId, 0);
    if (!options.privateTranscript)
      return {
        format: 'corral-history',
        formatVersion: 1,
        visibility: 'public',
        status: run.projection.status,
        events: events.map(({ runSeq, type, recordedAt }) => ({ runSeq, type, recordedAt })),
        counts: {
          executions: run.projection.executionOrder.length,
          artifacts: Object.keys(run.projection.artifacts).length,
          modelCalls: Object.keys(run.projection.modelCalls).length,
        },
      };
    const versionIds = new Set([
      run.snapshot.criteriaVersionId,
      ...Object.keys(run.projection.artifacts),
      ...recordReferences(events),
    ]);
    const artifacts: Record<string, string> = {};
    for (const id of versionIds) {
      const text = store.getArtifactText(runId, id);
      if (text === null) throw new Error('private history is missing a referenced record body');
      artifacts[id] = text;
    }
    return PrivateArchive.parse({
      format: 'corral-history',
      formatVersion: 1,
      visibility: 'private',
      runId,
      lastSeq: run.projection.lastSeq,
      snapshot: run.snapshot,
      events,
      artifacts,
      bodyHashes: Object.fromEntries(
        Object.entries(artifacts).map(([id, text]) => [id, bytesToHex(sha256(utf8ToBytes(text)))]),
      ),
    });
  });
}

/** An archive is data only. It never creates a Coordinator, replays effects, or writes a store. */
export function openRunArchive(input: unknown) {
  const archive = Archive.parse(input);
  for (const [index, event] of archive.events.entries()) {
    if (event.runSeq !== index + 1) throw new Error('archive event sequence is incomplete');
  }
  if (archive.visibility === 'public') return freeze(archive);
  const first = archive.events[0];
  if (first?.type !== 'run.started') throw new Error('archive has no run start');
  if (archive.lastSeq !== archive.events.length)
    throw new Error('archive event sequence is incomplete');
  const snapshot = archive.snapshot;
  if (
    definitionHash(snapshot.definition) !== snapshot.definitionHash ||
    first.payload.definitionHash !== snapshot.definitionHash ||
    first.payload.corralId !== snapshot.definition.id ||
    first.payload.mode !== snapshot.mode ||
    (first.payload.criteriaVersionId !== undefined &&
      first.payload.criteriaVersionId !== snapshot.criteriaVersionId) ||
    canonicalJson(
      first.payload.modelProfiles.toSorted((a, b) => a.profile.localeCompare(b.profile)),
    ) !==
      canonicalJson(
        Object.values(snapshot.models).toSorted((a, b) => a.profile.localeCompare(b.profile)),
      ) ||
    Date.parse(first.recordedAt) < Date.parse(snapshot.startedAt) ||
    first.payload.inputHash !==
      bytesToHex(sha256(utf8ToBytes(canonicalJson(snapshot.definition.input))))
  )
    throw new Error('archive snapshot does not match its run start');
  if (
    archive.artifacts[snapshot.criteriaVersionId] !== snapshot.definition.input.criteria.join('\n')
  )
    throw new Error('archive initial criteria are inconsistent');
  for (const id of recordReferences(archive.events)) {
    if (!(id in archive.artifacts)) throw new Error('archive is missing a criteria version');
  }
  for (const [id, text] of Object.entries(archive.artifacts)) {
    if (archive.bodyHashes[id] !== bytesToHex(sha256(utf8ToBytes(text))))
      throw new Error('archive body hash does not match');
  }
  if (Object.keys(archive.bodyHashes).length !== Object.keys(archive.artifacts).length)
    throw new Error('archive body manifest is incomplete');
  let projection = emptyProjection(archive.runId);
  for (const event of archive.events) {
    if (event.runId !== archive.runId) throw new Error('archive contains a different run');
    if (event.type === 'patch.committed' && event.payload.kind === 'criteria') {
      const { criteriaVersionId, criteria } = event.payload.after;
      if (
        typeof criteriaVersionId !== 'string' ||
        !Array.isArray(criteria) ||
        !criteria.every((item) => typeof item === 'string') ||
        archive.artifacts[criteriaVersionId] !== criteria.join('\n')
      )
        throw new Error('archive patched criteria are inconsistent');
    }
    projection = applyEvent(projection, event);
  }
  for (const id of Object.keys(projection.artifacts)) {
    const text = archive.artifacts[id];
    const artifact = projection.artifacts[id];
    if (text === undefined || !artifact) throw new Error('archive is missing an artifact body');
    const bytes = utf8ToBytes(text);
    if (bytes.length !== artifact.byteLength || bytesToHex(sha256(bytes)) !== artifact.contentHash)
      throw new Error('archive artifact content does not match its committed hash');
  }
  return freeze({ ...archive, projection });
}

function recordReferences(events: readonly RunEvent[]): Set<string> {
  const ids = new Set<string>();
  const tools = new Map<string, string>();
  const questions = new Set<string>();
  const answered = new Set<string>();
  const add = (id: unknown) => {
    if (typeof id === 'string') ids.add(id);
  };
  for (const event of events) {
    if (event.type === 'tool.requested') tools.set(event.payload.toolCallId, event.payload.name);
    if (event.type === 'message.question_created') questions.add(event.payload.questionId);
    if (event.type === 'message.answer_committed') answered.add(event.payload.questionId);
    if ('criteriaVersionId' in event.payload) add(event.payload.criteriaVersionId);
    if (event.type === 'review.stale') add(event.payload.newCriteriaVersionId);
    if (event.type === 'patch.committed' && event.payload.kind === 'criteria') {
      add(event.payload.before.criteriaVersionId);
      add(event.payload.after.criteriaVersionId);
    }
    if (event.type === 'model.finished') add(event.payload.responseRef);
    if (event.type === 'extension.ui_requested' || event.type === 'extension.ui_notified')
      add(event.payload.bodyRef);
    if (event.type === 'extension.ui_answered') add(event.payload.answerRef);
    if (event.type === 'tool.finished' && event.payload.resultRef) {
      const kind = tools.get(event.payload.toolCallId);
      const ref = event.payload.resultRef;
      if (kind === 'ask' || kind === 'reply') {
        if (!questions.has(ref) || !answered.has(ref))
          throw new Error('archive tool references a missing answered question');
      } else add(ref);
    }
  }
  return ids;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
