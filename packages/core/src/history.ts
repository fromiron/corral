import {
  AutoRoute,
  BinaryArtifact,
  BranchedFrom,
  ContinuedConversation,
  CorralDefinition,
  EffectiveHarnessSnapshot,
  Identifier,
  ImageGenerationProfile,
  ImageInput,
  MeetingRunOrigin,
  ModelProfileSnapshot,
  PermissionMode,
  ReasoningApplySettings,
  ResumedFrom,
  RunEvent,
  RunStatus,
  RuntimeCheckpointManifest,
  RuntimeCheckpointState,
  SessionConversation,
} from '@corral/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';
import { canonicalJson } from './canonical-json.ts';
import { checkpointReferences, decodeContextCheckpoint } from './context-checkpoint.ts';
import { definitionHash } from './definition-hash.ts';
import { applyEvent, emptyProjection } from './projection.ts';
import type { RunStore } from './store/run-store.ts';

/** The run record holding a session follow-up's copied turns. */
export const SESSION_CONVERSATION = 'session_conversation';

const Snapshot = z.strictObject({
  meeting: MeetingRunOrigin.optional(),
  permissionMode: PermissionMode.optional(),
  imageProfiles: z.record(Identifier, ImageGenerationProfile).optional(),
  resumedFrom: ResumedFrom.optional(),
  branchedFrom: BranchedFrom.optional(),
  conversation: ContinuedConversation.optional(),
  definition: CorralDefinition,
  definitionHash: z.string().regex(/^[0-9a-f]{64}$/),
  source: z
    .strictObject({ corralId: Identifier, definitionRevision: z.int().positive() })
    .nullable(),
  criteriaVersionId: Identifier,
  mode: z.enum(['mock', 'live']),
  models: z.record(Identifier, ModelProfileSnapshot),
  harnesses: z.record(Identifier, EffectiveHarnessSnapshot).optional(),
  reasoningApply: ReasoningApplySettings.optional(),
  autoRoute: AutoRoute.optional(),
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
  media: z
    .record(
      Identifier,
      z.strictObject({
        descriptor: BinaryArtifact,
        dataHex: z
          .string()
          .max(64 * 1024 * 1024)
          .regex(/^(?:[a-f0-9]{2})+$/),
      }),
    )
    .optional(),
  format: z.literal('corral-history'),
  formatVersion: z.union([z.literal(1), z.literal(2)]),
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
      ...(run.snapshot.definition.input.images ?? []).map((image) => image.imageId),
      ...(run.snapshot.resumedFrom ? [run.snapshot.resumedFrom.contextRef] : []),
      ...(run.snapshot.branchedFrom?.contextRef ? [run.snapshot.branchedFrom.contextRef] : []),
      ...(run.snapshot.meeting?.contextSource ? ['meeting_context'] : []),
      ...(run.snapshot.conversation ? [SESSION_CONVERSATION] : []),
      run.snapshot.criteriaVersionId,
      ...Object.keys(run.projection.artifacts),
      ...recordReferences(events),
    ]);
    const contextRefs = new Set(
      events.flatMap((event) =>
        event.type === 'runtime.checkpoint_created' ? [event.payload.contextRef] : [],
      ),
    );
    const artifacts: Record<string, string> = {};
    const media: Record<string, { descriptor: BinaryArtifact; dataHex: string }> = {};
    for (const id of versionIds) {
      const text = store.getArtifactText(runId, id);
      if (text === null) throw new Error('private history is missing a referenced record body');
      artifacts[id] = text;
      if (contextRefs.has(id))
        for (const ref of checkpointReferences(JSON.parse(text))) versionIds.add(ref);
      const descriptor = run.projection.artifacts[id]?.media;
      if (descriptor) {
        const bytes = store.getArtifactBinary?.(runId, id);
        if (
          !bytes ||
          bytes.length !== descriptor.bytes ||
          bytesToHex(sha256(bytes)) !== descriptor.sha256
        )
          throw new Error('private history is missing verified generated image bytes');
        media[id] = { descriptor, dataHex: bytesToHex(bytes) };
      }
    }
    return PrivateArchive.parse({
      format: 'corral-history',
      formatVersion: Object.keys(media).length ? 2 : 1,
      visibility: 'private',
      runId,
      lastSeq: run.projection.lastSeq,
      snapshot: run.snapshot,
      events,
      artifacts,
      ...(Object.keys(media).length ? { media } : {}),
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
  if (archive.formatVersion === 1 && Object.keys(archive.media ?? {}).length)
    throw new Error('generated media requires archive format version 2');
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
    first.payload.permissionMode !== snapshot.permissionMode ||
    canonicalJson(first.payload.imageProfiles ?? null) !==
      canonicalJson(snapshot.imageProfiles ?? null) ||
    canonicalJson(first.payload.reasoningApply ?? null) !==
      canonicalJson(snapshot.reasoningApply ?? null) ||
    canonicalJson(first.payload.autoRoute ?? null) !== canonicalJson(snapshot.autoRoute ?? null) ||
    canonicalJson(first.payload.meeting ?? null) !== canonicalJson(snapshot.meeting ?? null) ||
    canonicalJson(first.payload.branchedFrom ?? null) !==
      canonicalJson(snapshot.branchedFrom ?? null) ||
    canonicalJson(first.payload.resumedFrom ?? null) !==
      canonicalJson(snapshot.resumedFrom ?? null) ||
    canonicalJson(first.payload.conversation ?? null) !==
      canonicalJson(snapshot.conversation ?? null) ||
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
  if (snapshot.resumedFrom)
    RuntimeCheckpointState.parse(
      JSON.parse(archive.artifacts[snapshot.resumedFrom.contextRef] ?? 'null'),
    );
  if (snapshot.conversation) {
    const copied = SessionConversation.safeParse(
      JSON.parse(archive.artifacts[SESSION_CONVERSATION] ?? 'null'),
    );
    if (
      !copied.success ||
      bytesToHex(sha256(utf8ToBytes(canonicalJson(copied.data)))) !==
        snapshot.conversation.contextHash
    )
      throw new Error('archive session conversation changed');
  }
  if (snapshot.meeting?.contextSource) {
    const state = RuntimeCheckpointState.parse(
      JSON.parse(archive.artifacts.meeting_context ?? 'null'),
    );
    if (
      bytesToHex(sha256(utf8ToBytes(canonicalJson(state)))) !==
      snapshot.meeting.contextSource.contextHash
    )
      throw new Error('meeting context changed');
  }
  if (snapshot.branchedFrom?.contextRef) {
    const state = RuntimeCheckpointState.parse(
      JSON.parse(archive.artifacts[snapshot.branchedFrom.contextRef] ?? 'null'),
    );
    if (bytesToHex(sha256(utf8ToBytes(canonicalJson(state)))) !== snapshot.branchedFrom.contextHash)
      throw new Error('branch context changed');
  }
  for (const reference of snapshot.definition.input.images ?? []) {
    const image = ImageInput.parse(JSON.parse(archive.artifacts[reference.imageId] ?? 'null'));
    const { data: _data, ...metadata } = image;
    if (canonicalJson(metadata) !== canonicalJson(reference))
      throw new Error('archive image identity changed');
  }
  for (const [id, text] of Object.entries(archive.artifacts)) {
    if (archive.bodyHashes[id] !== bytesToHex(sha256(utf8ToBytes(text))))
      throw new Error('archive body hash does not match');
  }
  if (Object.keys(archive.bodyHashes).length !== Object.keys(archive.artifacts).length)
    throw new Error('archive body manifest is incomplete');
  let projection = emptyProjection(archive.runId);
  for (const event of archive.events) {
    if (event.type === 'runtime.checkpoint_created') {
      const manifest = RuntimeCheckpointManifest.parse(
        JSON.parse(archive.artifacts[event.payload.manifestRef] ?? 'null'),
      );
      const storedState = JSON.parse(archive.artifacts[event.payload.contextRef] ?? 'null');
      decodeContextCheckpoint(storedState, (id) => archive.artifacts[id] ?? null);
      if (
        manifest.runId !== archive.runId ||
        manifest.checkpointId !== event.payload.checkpointId ||
        manifest.contextRef !== event.payload.contextRef ||
        bytesToHex(sha256(utf8ToBytes(canonicalJson(manifest)))) !== event.payload.manifestHash ||
        bytesToHex(sha256(utf8ToBytes(canonicalJson(storedState)))) !== manifest.contextHash
      )
        throw new Error('archive runtime checkpoint changed');
    }
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
    if (artifact.media) {
      const blob = archive.media?.[id];
      if (!blob || canonicalJson(blob.descriptor) !== canonicalJson(artifact.media))
        throw new Error('archive generated image descriptor is missing or changed');
      const binary = hexToBytes(blob.dataHex);
      if (
        binary.length !== artifact.media.bytes ||
        bytesToHex(sha256(binary)) !== artifact.media.sha256
      )
        throw new Error('archive generated image content does not match its committed hash');
    }
  }
  if (Object.keys(archive.media ?? {}).some((id) => !projection.artifacts[id]?.media))
    throw new Error('archive contains unreferenced generated image bytes');
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
    if (event.type === 'model.request_prepared')
      for (const id of event.payload.inputArtifactVersionIds) add(id);
    if (event.type === 'runtime.checkpoint_created') {
      add(event.payload.contextRef);
      add(event.payload.manifestRef);
    }
    if (event.type === 'approval.requested' && event.payload.tool) add(event.payload.tool.bodyRef);
    if (
      event.type === 'work_plan.updated' ||
      event.type === 'user_input.requested' ||
      event.type === 'extension.ui_requested' ||
      event.type === 'extension.ui_notified'
    )
      add(event.payload.bodyRef);
    if (event.type === 'user_input.answered' || event.type === 'extension.ui_answered')
      add(event.payload.answerRef);
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
