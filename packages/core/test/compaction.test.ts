import type {
  AgentHost,
  AgentStartInput,
  CompactContextCommand,
  ModelRequestRecord,
} from '@corral/contracts';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import { Coordinator } from '../src/index.ts';

it('[TC-COMPACT-001-H] [TC-COMPACT-001-N] compaction is attempt-scoped, idempotent, and completed only with an owned settled compaction call', async () => {
  const ready = new Gate(),
    done = new Gate();
  const request = vi.fn();
  let host!: AgentHost, input!: AgentStartInput;
  const binding = { profileId: 'empty', revision: 1 },
    hash = 'a'.repeat(64);
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    models: {
      resolve: (profile) => ({
        ok: true,
        snapshot: { profile, provider: 'fixture', modelId: 'fixture', auth: 'api_key' },
      }),
    },
    harnesses: {
      resolve: () => ({
        binding,
        snapshotHash: hash,
        piVersion: '1.3.0',
        policyRevision: 1,
        policy: 'strict',
        resources: [],
        allowedTools: [],
        tools: [],
        diagnostics: [],
      }),
    },
    agents: {
      start: async (i, h) => {
        input = i;
        host = h;
        ready.open();
        return {
          requestCompaction: request,
          cancel: async () => done.open(),
          waitForSettlement: async () => {
            await done.wait();
            return { outcome: 'cancelled' };
          },
        };
      },
    },
  });
  const definition = linearCorral(['writer']);
  definition.roles[0]!.harness = binding;
  const result = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start_compact',
    definition,
    mode: 'live',
  });
  expect(result.runId).not.toBeNull();
  await ready.wait();
  try {
    await host.reportHarness!({ ok: true, snapshotHash: hash, tools: [], diagnostics: [] });
    const command: CompactContextCommand = {
      schemaVersion: '0.1',
      commandId: 'compact_1',
      runId: result.runId!,
      type: 'compact_context',
      expectedControlRevision: 0,
      payload: { executionId: input.executionId, attemptNo: 1 },
    };
    expect(
      coordinator.submit({
        ...command,
        commandId: 'old_attempt',
        payload: { ...command.payload, attemptNo: 2 },
      }).status,
    ).toBe('rejected');
    const accepted = coordinator.submit(command);
    expect(accepted.status).toBe('accepted');
    expect(coordinator.submit(command)).toEqual(accepted);
    expect(request).toHaveBeenCalledTimes(1);
    expect(coordinator.submit({ ...command, commandId: 'another_compact' }).status).toBe(
      'rejected',
    );
    await host.reportCompaction!({
      commandId: command.commandId,
      phase: 'started',
      beforeHash: hash,
      modelCallIds: [],
    });
    await expect(
      host.reportCompaction!({
        commandId: command.commandId,
        phase: 'completed',
        beforeHash: hash,
        afterHash: 'b'.repeat(64),
        modelCallIds: [],
      }),
    ).rejects.toThrow();
    const record: ModelRequestRecord = {
      purpose: 'compaction',
      runtime: 'pi-sdk',
      contextHash: hash,
      contextBytes: 100,
      directiveIds: [],
      sections: [],
    };
    const permit = await host.prepareModelRequest(record);
    await host.modelRequestDispatched!(permit.modelCallId);
    await host.observe({
      kind: 'model_completed',
      modelCallId: permit.modelCallId,
      text: 'summary',
      usage: { inputTokens: 100, outputTokens: 10 },
    });
    await host.reportCompaction!({
      commandId: command.commandId,
      phase: 'completed',
      beforeHash: hash,
      afterHash: 'b'.repeat(64),
      modelCallIds: [permit.modelCallId],
    });
    expect(coordinator.submit(command).status).toBe('applied');
    expect(coordinator.getSnapshot(input.runId).projection.budget.modelCalls).toBe(1);
    expect(coordinator.getSnapshot(input.runId).projection.tasks[input.taskId]?.status).not.toBe(
      'completed',
    );
  } finally {
    done.open();
  }
});
