import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentHost, type AgentStartInput, canonicalJson } from '@corral/contracts';
import { Coordinator, exportRunArchive, openRunArchive, resolveProfileContext } from '@corral/core';
import { openDatabase, SqliteRunStore } from '@corral/storage-sqlite';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import { pruneToolResults } from '../../../packages/adapter-pi/src/ported/dsh/context.ts';
import { checkpointReferences } from '../../../packages/core/src/context-checkpoint.ts';

const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

it.each([false, true])(
  'a private checkpoint preserves its policy across restart (recorded=%s)',
  async (recorded) => {
    const directory = mkdtempSync(join(tmpdir(), 'corral-runtime-checkpoint-')),
      path = join(directory, 'state.db');
    let db = openDatabase(path);
    const started = new Gate(),
      resumed = new Gate(),
      done = new Gate();
    let resumedHost!: AgentHost;
    let sourceHost!: AgentHost, sourceInput!: AgentStartInput, resumedInput!: AgentStartInput;
    const confirm = vi.fn(async () => {});
    let modelId = 'fixture';
    const originalPolicy = resolveProfileContext(
      { contextWindow: 64000 },
      { contextWindow: 128000, source: 'catalog' },
      'before',
      4096,
    ).policy!;
    let contextPolicy = recorded ? originalPolicy : undefined;
    const models = {
      resolve: (profile: string) => ({
        ok: true as const,
        snapshot: {
          profile,
          provider: 'fixture',
          modelId,
          auth: 'api_key' as const,
          ...(contextPolicy ? { contextWindow: contextPolicy.contextWindow, contextPolicy } : {}),
        },
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
        tools: {
          execute: async () => ({
            text: 'x'.repeat(10000) + 'MIDDLE_SOURCE_IDENTIFIER' + 'y'.repeat(10000),
          }),
        },
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
        definition: {
          ...linearCorral(['writer']),
          limits: { ...linearCorral(['writer']).limits, maxModelCalls: 1 },
          roles: linearCorral(['writer']).roles.map((role) => ({
            ...role,
            allowedWorkTools: ['write_artifact', 'read_document'],
            allowedCollaborationTools: ['submit_result', 'read_artifact'],
          })),
        },
        mode: 'live',
      });
      expect(created.runId).not.toBeNull();
      await started.wait();
      const permit = await sourceHost.prepareModelRequest();
      const context: { messages: Record<string, unknown>[] } = {
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
      const original = await sourceHost.invokeTool({
        name: 'read_document',
        args: { documentId: 'fixture' },
      });
      if (!original.ok) throw new Error(original.error.message);
      const toolMessage = {
        role: 'toolResult' as const,
        toolName: 'read_document',
        toolCallId: 'pi_read',
        content: [{ type: 'text' as const, text: JSON.stringify(original.result) }],
        timestamp: 2,
        isError: false,
        details: { contextSource: { toolCallId: original.toolCallId } },
      };
      const pruned = pruneToolResults({
        messages: [
          toolMessage,
          {
            role: 'assistant' as const,
            content: [],
            api: 'faux',
            provider: 'faux',
            model: 'faux',
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop' as const,
            timestamp: 3,
          },
        ],
      });
      expect(JSON.stringify(pruned)).not.toContain('MIDDLE_SOURCE_IDENTIFIER');
      context.messages.push(...pruned.messages);
      const beforeSummary = await sourceHost.checkpointContext!({
        version: 1,
        piVersion: '1.3.0',
        runtime: 'pi-core',
        context,
        contextHash: hash(context),
      });
      expect(beforeSummary).not.toBeNull();
      const unprojected = await sourceHost.invokeTool({
        name: 'read_document',
        args: { documentId: 'another' },
      });
      if (!unprojected.ok) throw new Error(unprojected.error.message);
      const newSourceRef = sourceStore.getRun(created.runId!)!.projection.toolCalls[
        unprojected.toolCallId
      ]!.resultRef;
      const previousBodies = new Set([
        ...checkpointReferences(
          JSON.parse(sourceStore.getArtifactText(created.runId!, beforeSummary!.contextRef)!),
        ),
        ...sourceInput.inputs.map((input) => input.sourceRef),
        sourceStore.getRun(created.runId!)!.projection.toolCalls[original.toolCallId]!.resultRef,
      ]);
      const checkpointReads = vi.spyOn(sourceStore, 'getArtifactText');
      // Compaction keeps the evidence reference after removing the old toolResult message.
      context.messages = [
        {
          role: 'user',
          content: `Private preserved request. Earlier evidence: read_artifact toolCallId ${original.toolCallId} or ${unprojected.toolCallId}.`,
          timestamp: 4,
        },
      ];
      const checkpoint = await sourceHost.checkpointContext!({
        version: 1,
        piVersion: '1.3.0',
        runtime: 'pi-core',
        context,
        contextHash: hash(context),
      });
      expect(checkpoint).not.toBeNull();
      expect(checkpointReads.mock.calls.filter(([, ref]) => previousBodies.has(ref))).toEqual([]);
      expect(checkpointReads.mock.calls.filter(([, ref]) => ref === newSourceRef)).toHaveLength(1);
      checkpointReads.mockRestore();
      const reads = vi.spyOn(sourceStore, 'readEvents');
      sourceHost.protectedContext!();
      sourceHost.protectedContext!();
      expect(reads).toHaveBeenCalledTimes(1);
      reads.mockRestore();

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
      const restartedStore = new SqliteRunStore(db);
      const restarted = new Coordinator({
        clock,
        timers: clock,
        ids: new SequentialIdFactory('restarted'),
        store: restartedStore,
        models,
        tools: {
          execute: async () => ({
            text: 'x'.repeat(10000) + 'MIDDLE_SOURCE_IDENTIFIER' + 'y'.repeat(10000),
          }),
        },
        runtimeRecovery: { confirm },
        agents: {
          start: async (input, host) => {
            resumedHost = host;
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
      contextPolicy = resolveProfileContext(
        { contextWindow: 96000 },
        { contextWindow: 128000, source: 'catalog' },
        'after',
        4096,
      ).policy!;
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
      const restoreReads = vi.spyOn(restartedStore, 'getArtifactText');
      const continued = await restarted.resumeRuntime(request);
      expect(restoreReads.mock.calls.some(([, ref]) => ref === beforeSummary!.contextRef)).toBe(
        false,
      );
      restoreReads.mockRestore();
      expect(continued.runId).not.toBeNull();
      expect(continued.runId).not.toBe(created.runId);
      expect(new SqliteRunStore(db).getRun(continued.runId!)?.sessionId).toBe('session_resume');
      await resumed.wait();
      expect(resumedInput.executionId).not.toBe(sourceInput.executionId);
      for (const toolCallId of [original.toolCallId, unprojected.toolCallId]) {
        const sourceRange = await resumedHost.invokeTool({
          name: 'read_artifact',
          args: { toolCallId, offset: 9900, limit: 300 },
        });
        expect(sourceRange).toMatchObject({
          ok: true,
          result: { text: expect.stringContaining('MIDDLE_SOURCE_IDENTIFIER') },
        });
      }
      expect(
        (
          await resumedHost.invokeTool({
            name: 'read_artifact',
            args: { toolCallId: 'unrelated_old_tool' },
          })
        ).ok,
      ).toBe(false);

      expect(resumedInput.model.contextPolicy).toEqual(recorded ? originalPolicy : undefined);
      expect(resumedInput.model.contextWindow).toBe(recorded ? 64000 : undefined);
      expect(JSON.stringify(resumedInput.resumeContext)).toContain('Private preserved request');
      expect(restarted.getRunSnapshot(continued.runId!)?.resumedFrom).toMatchObject({
        runId: created.runId,
        checkpointId: preview.checkpointId,
      });
      expect(preview.usageLimits).toBe('none');
      expect(restarted.getSnapshot(continued.runId!).projection.usageLimits).toBe('none');
      expect(restarted.getRunSnapshot(continued.runId!)?.definition.limits.maxModelCalls).toBe(1);
      expect(restarted.getRunSnapshot(continued.runId!)?.definition.limits.maxOutputTokens).toBe(
        64000,
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
  },
);
