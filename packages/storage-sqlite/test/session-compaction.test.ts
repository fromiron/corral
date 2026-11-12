import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionCommand } from '@corral/contracts';
import { Coordinator, InProcessTransport, waitForProjection } from '@corral/core';
import {
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, SqliteRunStore } from '../src/index.ts';

const dirs: string[] = [];
function path() {
  const dir = mkdtempSync(join(tmpdir(), 'corral-session-compaction-'));
  dirs.push(dir);
  return join(dir, 'workspace.db');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SESSION = 'session_chat';
const compact: SessionCommand = {
  schemaVersion: '0.1',
  type: 'compact_session',
  commandId: 'cmd_compact',
  sessionId: SESSION,
  expectedSessionRevision: 1,
};

describe('durable session compaction', () => {
  it('keeps the receipt and summary across a restart without closing admission', async () => {
    const file = path();
    let calls = 0;
    const open = () => {
      const db = openDatabase(file);
      const coordinator = new Coordinator({
        clock: new FakeClock(),
        ids: new SequentialIdFactory(`b${calls}`),
        store: new SqliteRunStore(db),
        agents: new ScriptedAgentAdapter({ turns: 1, appendNotes: false }),
        models: {
          resolve: () => ({
            ok: true,
            snapshot: {
              profile: 'writer',
              provider: 'openai',
              modelId: 'gpt-test',
              auth: 'api_key',
            },
          }),
        },
        sessionFacts: { revision: () => 1, modelProfile: () => 'writer' },
        sessionCompaction: {
          complete: async () => {
            calls += 1;
            return { text: 'Goal.', stopReason: 'stop' };
          },
        },
      });
      return { db, coordinator };
    };
    const first = open();
    const definition = linearCorral(['writer']);
    definition.input = { ...definition.input, brief: 'A request long enough to summarize.' };
    const started = first.coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_run',
      definition,
      mode: 'mock',
      sessionId: SESSION,
    });
    await waitForProjection(
      new InProcessTransport(first.coordinator),
      started.runId ?? '',
      (p) => p.status === 'succeeded',
    );
    const receipt = first.coordinator.submitSession(compact);
    expect(receipt.status).toBe('accepted');
    for (let i = 0; i < 20 && first.coordinator.sessionCompactions(SESSION).length === 0; i++)
      await Promise.resolve();
    expect(first.coordinator.sessionCompactions(SESSION).map((item) => item.phase)).toEqual([
      'completed',
    ]);
    expect(
      first.coordinator.submitSession({ ...compact, commandId: 'cmd_other', sessionId: 'missing' })
        .error?.code,
    ).not.toBe('STORAGE_UNAVAILABLE');
    expect(() =>
      first.db.prepare('DELETE FROM session_compactions WHERE session_id = ?').run(SESSION),
    ).toThrow(/immutable/);
    first.db.close();

    const restarted = open();
    expect(restarted.coordinator.submitSession(compact)).toEqual(receipt);
    expect(calls).toBe(1);
    expect(restarted.coordinator.sessionCompactionView(SESSION)?.commandId).toBe('cmd_compact');
    restarted.db.close();
  });
});
