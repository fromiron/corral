import type { ModelAttempt } from '@corral/contracts';
import { expect, it } from 'vitest';
import { openDatabase, SqliteModelAttemptStore } from '../src/index.ts';

const attempt = (id: string): ModelAttempt => ({
  version: 2,
  attemptId: id,
  intent: { requestId: id, purpose: 'draft', revision: 0, owner: { kind: 'draft', id: 'owner' } },
  provider: 'fixture',
  modelId: 'fixture',
  status: 'completed',
  startedAt: '2026-10-24T00:00:00Z',
  endedAt: '2026-10-24T00:00:01Z',
  payloadHash: null,
  payloadBytes: null,
  firstEventAt: null,
  failure: null,
  usage: {
    version: 2,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    source: 'unknown',
    costStatus: 'unknown',
    costUsd: null,
  },
});
it('[TC-LLM-002-F] attempt history is idempotent, preserves identity and pages without repeating a reconciled row', () => {
  const db = openDatabase(':memory:');
  try {
    const store = new SqliteModelAttemptStore(db);
    for (const id of ['a', 'b', 'c']) store.put(attempt(id));
    store.put(attempt('b'));
    expect(db.prepare('SELECT COUNT(*) AS n FROM model_attempt_events').get()).toEqual({ n: 3 });
    expect(() =>
      store.put({ ...attempt('b'), intent: { ...attempt('b').intent, requestId: 'changed' } }),
    ).toThrow(/identity/);
    const page = store.page({ limit: 2 });
    expect(page.items.map((row) => row.attemptId)).toEqual(['c', 'b']);
    store.put({
      ...attempt('b'),
      usage: { ...attempt('b').usage, source: 'reported', inputTokens: 0, outputTokens: 0 },
    });
    expect(
      store.page({ limit: 2, before: page.nextCursor! }).items.map((row) => row.attemptId),
    ).toEqual(['a']);
    expect(store.page({ ownerId: 'unowned' }).items).toEqual([]);
  } finally {
    db.close();
  }
});

it('[TC-LLM-002-F] restart records unfinished attempts as unknown and keeps settled usage', () => {
  const db = openDatabase(':memory:');
  try {
    const store = new SqliteModelAttemptStore(db);
    store.put({ ...attempt('pending'), status: 'started', endedAt: null });
    store.put(attempt('complete'));
    store.recoverInterrupted('2026-10-24T01:00:00Z');
    store.recoverInterrupted('2026-10-24T02:00:00Z');
    expect(store.get('pending')).toMatchObject({
      status: 'unknown',
      endedAt: '2026-10-24T01:00:00Z',
      failure: { code: 'PROCESS_INTERRUPTED' },
    });
    expect(store.get('complete')).toEqual(attempt('complete'));
    expect(db.prepare('SELECT COUNT(*) AS n FROM model_attempt_events').get()).toEqual({ n: 3 });
  } finally {
    db.close();
  }
});
