import { canonicalJson, type RuntimeCheckpointState } from '@corral/contracts';
import { linearCorral } from '@corral/testkit';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { expect, it } from 'vitest';
import { decodeContextCheckpoint, encodeContextCheckpoint } from '../src/context-checkpoint.ts';

const hash = (value: unknown) => bytesToHex(sha256(utf8ToBytes(canonicalJson(value))));
it('immutable message chunks deduplicate growing checkpoints and reject missing or changed sources', () => {
  const context = { messages: [{ role: 'user', content: 'source '.repeat(10000), timestamp: 1 }] };
  const state: RuntimeCheckpointState = {
    version: 1,
    context: {
      version: 1,
      piVersion: '1.3.0',
      runtime: 'pi-core',
      context,
      contextHash: hash(context),
    },
    role: linearCorral(['writer']).roles[0]!,
    criteria: 'Preserve evidence',
    protectedContext: { version: 1, text: 'current', hash: hash('current') },
  };
  const first = encodeContextCheckpoint(state);
  const bodies = new Map(first.chunks);
  const next = JSON.parse(JSON.stringify(state));
  next.context.context.messages.push({ role: 'user', content: 'next', timestamp: 2 });
  next.context.contextHash = hash(next.context.context);
  const second = encodeContextCheckpoint(next);
  const extraBytes = [...second.chunks]
    .filter(([id]) => !bodies.has(id))
    .reduce((sum, [, text]) => sum + text.length, 0);
  expect(extraBytes).toBeLessThan(100);
  for (const [id, body] of second.chunks) bodies.set(id, body);
  expect(decodeContextCheckpoint(second.stored, (id) => bodies.get(id) ?? null)).toEqual(next);
  expect(decodeContextCheckpoint(state, () => null)).toEqual(state);
  expect(() =>
    decodeContextCheckpoint(
      { ...state, context: { ...state.context, contextHash: '0'.repeat(64) } },
      () => null,
    ),
  ).toThrow(/projection changed/);
  expect(() => decodeContextCheckpoint(first.stored, () => 'changed')).toThrow();
  expect(() => decodeContextCheckpoint(first.stored, () => null)).toThrow();
});
