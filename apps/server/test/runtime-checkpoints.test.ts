import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentHost, type AgentStartInput, canonicalJson } from '@corral/contracts';
import { Coordinator, exportRunArchive, openRunArchive } from '@corral/core';
import { openDatabase, SqliteRunStore } from '@corral/storage-sqlite';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { expect, it, vi } from 'vitest';

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

it('[TC-RESUME-001-H] [TC-RESUME-001-N] a private checkpoint survives restart and continues as a new run without reusing the old owner or budget', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'corral-runtime-checkpoint-')),
    path = join(directory, 'state.db');
  let db = openDatabase(path);
  const started = new Gate(),
    resumed = new Gate(),
    done = new Gate();
  let sourceHost!: AgentHost, sourceInput!: AgentStartInput, resumedInput!: AgentStartInput;
  const confirm = vi.fn(async () => {});
  let modelId = 'fixture';
  const models = {
    resolve: (profile: string) => ({
      ok: true as const,
      snapshot: { profile, provider: 'fixture', modelId, auth: 'api_key' as const },
    }),
  };
  const clock = new FakeClock();
  try {
    db.prepare(
      "INSERT INTO work_sessions (id, project_id, corral_id, title, objective, pinned, revision, created_at, updated_at, archived_at, entries_json) VALUES ('session_resume', 'default', NULL, 'Resume', '', 0, 1, 'x', 'x', NULL, '[]')",
    ).run();
    const sourceStore = new SqliteRunStore(db);
    const source = new Coordinator({
      clock,
      timers: clock,
      ids: new SequentialIdFactory('source'),
      store: sourceStore,
      models,
      runtimeRecovery: { confirm },
      agents: {
        start: async (input, host) => {
          sourceInput = input;
          sourceHost = host;
          started.open();
          return { cancel: async () => {}, waitForSettlement: () => new Promise(() => {}) };
        },
      },
    });
    const created = source.startRun({
      schemaVersion: '0.1',
      commandId: 'source_start',
      sessionId: 'session_resume',
      definition: linearCorral(['writer']),
      mode: 'live',
    });
    expect(created.runId).not.toBeNull();
    await started.wait();
    const permit = await sourceHost.prepareModelRequest();
    const context = {
      messages: [{ role: 'user', content: 'Private preserved request', timestamp: 1 }],
    };
    expect(
      await sourceHost.checkpointContext!({
        version: 1,
        piVersion: '1.3.0',
        runtime: 'pi-core',
        context,
        contextHash: hash(context),
      }),
    ).toBeNull();
    await sourceHost.modelRequestDispatched!(permit.modelCallId);
    await sourceHost.observe({
      kind: 'model_completed',
      modelCallId: permit.modelCallId,
      text: 'Prior response',
      usage: { inputTokens: 10, outputTokens: 12 },
    });
    await expect(
      sourceHost.checkpointContext!({
        version: 1,
        piVersion: '1.3.0',
        runtime: 'pi-core',
        context,
        contextHash: '0'.repeat(64),
      }),
    ).rejects.toThrow('invalid');
    const checkpoint = await sourceHost.checkpointContext!({
      version: 1,
      piVersion: '1.3.0',
      runtime: 'pi-core',
      context,
      contextHash: hash(context),
    });
    expect(checkpoint).not.toBeNull();
    expect(JSON.stringify(sourceStore.readEvents(created.runId!, 0))).not.toContain(
      'Private preserved',
    );
    expect(JSON.stringify(exportRunArchive(sourceStore, created.runId!))).not.toContain(
      'Private preserved',
    );
    expect(
      JSON.stringify(exportRunArchive(sourceStore, created.runId!, { privateTranscript: true })),
    ).toContain('Private preserved');
    expect(
      openRunArchive(exportRunArchive(sourceStore, created.runId!, { privateTranscript: true })),
    ).toBeDefined();
    expect((await source.runtimeCheckpoints(created.runId!))[0]?.blockers).toContain(
      'source_not_stopped',
    );
    db.close();
    db = openDatabase(path);
    const restarted = new Coordinator({
      clock,
      timers: clock,
      ids: new SequentialIdFactory('restarted'),
      store: new SqliteRunStore(db),
      models,
      runtimeRecovery: { confirm },
      agents: {
        start: async (input) => {
          resumedInput = input;
          resumed.open();
          return {
            cancel: async () => done.open(),
            waitForSettlement: async () => {
              await done.wait();
              return { outcome: 'cancelled' };
            },
          };
        },
      },
    });
    expect(restarted.getSnapshot(created.runId!).projection.status).toBe('interrupted');
    const preview = (await restarted.runtimeCheckpoints(created.runId!))[0]!;
    expect(preview.ready).toBe(true);
    modelId = 'different';
    expect((await restarted.runtimeCheckpoints(created.runId!))[0]?.blockers).toContain(
      'model_changed',
    );
    modelId = 'fixture';
    const request = {
      commandId: 'continue_checkpoint',
      sourceRunId: created.runId!,
      checkpointId: preview.checkpointId,
      manifestHash: preview.manifestHash,
      expectedSourceSeq: preview.sourceSeq,
    };
    expect(
      (
        await restarted.resumeRuntime({
          ...request,
          commandId: 'bad_hash',
          manifestHash: '0'.repeat(64),
        })
      ).receipt.status,
    ).toBe('rejected');
    expect(
      (
        await restarted.resumeRuntime({
          ...request,
          commandId: 'old_sequence',
          expectedSourceSeq: preview.sourceSeq - 1,
        })
      ).receipt.status,
    ).toBe('rejected');
    const continued = await restarted.resumeRuntime(request);
    expect(continued.runId).not.toBeNull();
    expect(continued.runId).not.toBe(created.runId);
    expect(new SqliteRunStore(db).getRun(continued.runId!)?.sessionId).toBe('session_resume');
    await resumed.wait();
    expect(resumedInput.executionId).not.toBe(sourceInput.executionId);
    expect(JSON.stringify(resumedInput.resumeContext)).toContain('Private preserved request');
    expect(restarted.getRunSnapshot(continued.runId!)?.resumedFrom).toMatchObject({
      runId: created.runId,
      checkpointId: preview.checkpointId,
    });
    expect(restarted.getRunSnapshot(continued.runId!)?.definition.limits.maxModelCalls).toBe(39);
    expect(restarted.getRunSnapshot(continued.runId!)?.definition.limits.maxOutputTokens).toBe(
      63988,
    );
    expect(await restarted.resumeRuntime(request)).toEqual(continued);
    expect(restarted.getSnapshot(created.runId!).projection.status).toBe('interrupted');
    expect((await restarted.runtimeCheckpoints(created.runId!))[0]?.blockers).toContain(
      'already_resumed',
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(
      openRunArchive(
        exportRunArchive(new SqliteRunStore(db), continued.runId!, { privateTranscript: true }),
      ),
    ).toBeDefined();
  } finally {
    done.open();
    await Promise.resolve();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
