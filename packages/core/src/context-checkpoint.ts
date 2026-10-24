import { ContextCheckpointV2, canonicalJson, RuntimeCheckpointState } from '@corral/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

const hash = (text: string) => bytesToHex(sha256(utf8ToBytes(text)));

/** Existing immutable artifact bodies provide content-addressed storage within the Run. */
export function encodeContextCheckpoint(
  state: RuntimeCheckpointState,
  committedSources: NonNullable<ContextCheckpointV2['sources']> = [],
) {
  const chunks = new Map<string, string>();
  const reference = (value: unknown) => {
    const text = canonicalJson(value),
      contentHash = hash(text),
      artifactVersionId = `ctx_${contentHash}`;
    chunks.set(artifactVersionId, text);
    return { artifactVersionId, hash: contentHash, bytes: utf8ToBytes(text).length };
  };
  const stored = ContextCheckpointV2.parse({
    version: 2,
    piVersion: state.context.piVersion,
    runtime: state.context.runtime,
    contextHash: state.context.contextHash,
    messages: state.context.context.messages.map(reference),
    role: reference(state.role),
    criteria: reference(state.criteria),
    protectedContext: reference(state.protectedContext),
    ...(committedSources.length || state.sources?.length
      ? { sources: [...committedSources, ...(state.sources ?? []).map(reference)] }
      : {}),
  });
  return { stored, chunks, text: canonicalJson(stored) };
}
export function checkpointReferences(raw: unknown): string[] {
  if ((raw as { version?: unknown } | null)?.version !== 2) return [];
  const stored = ContextCheckpointV2.parse(raw);
  return [
    ...stored.messages,
    stored.role,
    stored.criteria,
    stored.protectedContext,
    ...(stored.sources ?? []),
  ].map((item) => item.artifactVersionId);
}
export function decodeContextCheckpoint(
  raw: unknown,
  read: (id: string) => string | null,
): RuntimeCheckpointState {
  let state: RuntimeCheckpointState;
  if ((raw as { version?: unknown } | null)?.version !== 2) {
    state = RuntimeCheckpointState.parse(raw);
  } else {
    const stored = ContextCheckpointV2.parse(raw);
    const value = (ref: typeof stored.role) => {
      const text = read(ref.artifactVersionId);
      if (text === null || hash(text) !== ref.hash || utf8ToBytes(text).length !== ref.bytes)
        throw new Error('checkpoint referenced content is missing or changed');
      return JSON.parse(text) as unknown;
    };
    state = RuntimeCheckpointState.parse({
      version: 1,
      context: {
        version: 1,
        runtime: stored.runtime,
        piVersion: stored.piVersion,
        context: { messages: stored.messages.map(value) },
        contextHash: stored.contextHash,
      },
      role: value(stored.role),
      criteria: value(stored.criteria),
      protectedContext: value(stored.protectedContext),
      ...(stored.sources ? { sources: stored.sources.map(value) } : {}),
    });
  }
  if (hash(canonicalJson(state.context.context)) !== state.context.contextHash)
    throw new Error('checkpoint projection changed');
  return state;
}
