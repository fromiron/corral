import type {
  AgentHost,
  AgentStartInput,
  CompactContextCommand,
  ModelRequestRecord,
} from '@corral/contracts';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import { Coordinator, InMemoryRunStore } from '../src/index.ts';

it('compaction is attempt-scoped, idempotent, and completed only with an owned settled compaction call', async () => {
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
    expect(Object.keys(coordinator.getSnapshot(input.runId).projection.modelCalls)).toHaveLength(1);
    expect(coordinator.getSnapshot(input.runId).projection.tasks[input.taskId]?.status).not.toBe(
      'completed',
    );
  } finally {
    done.open();
  }
});

it('a live Core execution accepts manual compaction without a harness', async () => {
  const ready = new Gate(),
    done = new Gate();
  const request = vi.fn();
  let input!: AgentStartInput;
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    models: {
      resolve: (profile, mode) => ({
        ok: true,
        snapshot:
          mode === 'mock'
            ? { profile, provider: null, modelId: null, auth: 'mock' }
            : { profile, provider: 'fixture', modelId: 'fixture', auth: 'api_key' },
      }),
    },
    agents: {
      start: async (start) => {
        input = start;
        ready.open();
        return {
          requestCompaction: request,
          cancel: async () => done.open(),
          waitForSettlement: async () => {
            await done.wait();
            return { outcome: 'cancelled' as const };
          },
        };
      },
    },
  });
  const definition = linearCorral(['writer']);
  const result = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start_core_compact',
    definition,
    mode: 'live',
  });
  expect(result.runId).not.toBeNull();
  await ready.wait();
  await Promise.resolve();
  try {
    expect(input.harness).toBeUndefined();
    expect(input.role.harness).toBeUndefined();
    const command: CompactContextCommand = {
      schemaVersion: '0.1',
      commandId: 'compact_core',
      runId: result.runId!,
      type: 'compact_context',
      expectedControlRevision: coordinator.getSnapshot(result.runId!).projection.controlRevision,
      payload: { executionId: input.executionId, attemptNo: input.attemptNo },
    };
    expect(coordinator.submit(command).status).toBe('accepted');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(command.commandId);
    expect(
      coordinator.submit({
        ...command,
        commandId: 'compact_core_stale',
        payload: { ...command.payload, attemptNo: input.attemptNo + 1 },
      }).status,
    ).toBe('rejected');
  } finally {
    done.open();
  }
});

it('an automatic compaction is recorded from started without a command and keeps the attempt and evidence rules', async () => {
  const store = new InMemoryRunStore();
  const failFirst = new Gate(),
    second = new Gate(),
    done = new Gate();
  const starts: { host: AgentHost; input: AgentStartInput }[] = [];
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    store,
    models: {
      resolve: (profile) => ({
        ok: true,
        snapshot: { profile, provider: 'fixture', modelId: 'fixture', auth: 'api_key' },
      }),
    },
    agents: {
      start: async (input, host) => {
        starts.push({ input, host });
        const first = starts.length === 1;
        if (!first) second.open();
        return {
          requestCompaction: vi.fn(),
          cancel: async () => done.open(),
          waitForSettlement: async () => {
            if (first) {
              await failFirst.wait();
              return { outcome: 'failed' as const, error: 'fixture failure' };
            }
            await done.wait();
            return { outcome: 'cancelled' as const };
          },
        };
      },
    },
  });
  const definition = linearCorral(['writer']);
  const node = definition.nodes.find((n) => n.type === 'agent')!;
  if (node.type === 'agent' && node.invocation !== 'observer') node.retry = { maxAttempts: 1 };
  const result = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start_auto_compact',
    definition,
    mode: 'live',
  });
  const runId = result.runId!;
  expect(runId).not.toBeNull();
  await vi.waitFor(() => expect(starts).toHaveLength(1));
  const hash = 'a'.repeat(64);
  const record: ModelRequestRecord = {
    purpose: 'compaction',
    runtime: 'pi-core',
    contextHash: hash,
    contextBytes: 100,
    directiveIds: [],
    sections: [],
  };
  const settledCall = async (host: AgentHost) => {
    const permit = await host.prepareModelRequest(record);
    await host.modelRequestDispatched!(permit.modelCallId);
    await host.observe({
      kind: 'model_completed',
      modelCallId: permit.modelCallId,
      text: 'summary',
      usage: { inputTokens: 100, outputTokens: 10 },
    });
    return permit.modelCallId;
  };
  try {
    const { host, input } = starts[0]!;
    const id = `compaction.1.${input.executionId}`;
    const auto = { commandId: id, trigger: 'automatic' as const };
    // A result is not accepted before its start.
    await expect(
      host.reportCompaction!({ ...auto, phase: 'failed', beforeHash: hash, modelCallIds: [] }),
    ).rejects.toThrow();
    await host.reportCompaction!({ ...auto, phase: 'started', beforeHash: hash, modelCallIds: [] });
    // The same report again is ignored.
    await host.reportCompaction!({ ...auto, phase: 'started', beforeHash: hash, modelCallIds: [] });
    await expect(
      host.reportCompaction!({
        ...auto,
        phase: 'completed',
        beforeHash: hash,
        afterHash: 'b'.repeat(64),
        modelCallIds: [],
      }),
    ).rejects.toThrow();
    const modelCallId = await settledCall(host);
    const completed = {
      ...auto,
      phase: 'completed' as const,
      beforeHash: hash,
      afterHash: 'b'.repeat(64),
      modelCallIds: [modelCallId],
    };
    await host.reportCompaction!(completed);
    await host.reportCompaction!(completed);
    await expect(
      host.reportCompaction!({ ...completed, phase: 'failed', modelCallIds: [] }),
    ).rejects.toThrow();
    // An automatic report cannot take over a manual record's id, nor the reverse.
    await expect(
      host.reportCompaction!({
        commandId: id,
        phase: 'started',
        beforeHash: hash,
        modelCallIds: [],
      }),
    ).rejects.toThrow();

    const events = store
      .readEvents(runId, 0)
      .filter((event) => event.type === 'context.compaction_changed');
    expect(events.map((event) => event.payload.phase)).toEqual(['started', 'completed']);
    expect(events.every((event) => event.commandId === undefined)).toBe(true);
    expect(events.every((event) => event.payload.trigger === 'automatic')).toBe(true);
    expect(coordinator.getSnapshot(runId).projection.compactions?.[id]?.phase).toBe('completed');

    // A later attempt cannot report on the first attempt's compaction, and the old attempt
    // cannot report on the new one's.
    failFirst.open();
    await second.wait();
    const next = starts[1]!;
    expect(next.input.attemptNo).toBe(2);
    await expect(
      next.host.reportCompaction!({ ...completed, phase: 'failed', modelCallIds: [] }),
    ).rejects.toThrow();
    const nextId = `compaction.1.${next.input.executionId}`;
    await next.host.reportCompaction!({
      commandId: nextId,
      trigger: 'automatic',
      phase: 'started',
      beforeHash: hash,
      modelCallIds: [],
    });
    await expect(
      host.reportCompaction!({
        commandId: nextId,
        trigger: 'automatic',
        phase: 'failed',
        beforeHash: hash,
        afterHash: hash,
        modelCallIds: [],
      }),
    ).rejects.toThrow();
    // An automatic compaction in progress does not make a manual one pending.
    expect(
      coordinator.submit({
        schemaVersion: '0.1',
        commandId: 'compact_after_auto',
        runId,
        type: 'compact_context',
        expectedControlRevision: coordinator.getSnapshot(runId).projection.controlRevision,
        payload: { executionId: next.input.executionId, attemptNo: 2 },
      }).status,
    ).toBe('accepted');
  } finally {
    failFirst.open();
    done.open();
  }
});

it('a simulated run refuses manual compaction even when the agent offers it', async () => {
  const ready = new Gate(),
    done = new Gate();
  const request = vi.fn();
  let input!: AgentStartInput;
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    models: {
      resolve: (profile) => ({
        ok: true,
        snapshot: { profile, provider: null, modelId: null, auth: 'mock' as const },
      }),
    },
    agents: {
      start: async (start) => {
        input = start;
        ready.open();
        return {
          requestCompaction: request,
          cancel: async () => done.open(),
          waitForSettlement: async () => {
            await done.wait();
            return { outcome: 'cancelled' as const };
          },
        };
      },
    },
  });
  const result = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start_mock_compact',
    definition: linearCorral(['writer']),
    mode: 'mock',
  });
  expect(result.runId).not.toBeNull();
  await ready.wait();
  await Promise.resolve();
  try {
    expect(
      coordinator.submit({
        schemaVersion: '0.1',
        commandId: 'compact_mock',
        runId: result.runId!,
        type: 'compact_context',
        expectedControlRevision: coordinator.getSnapshot(result.runId!).projection.controlRevision,
        payload: { executionId: input.executionId, attemptNo: input.attemptNo },
      }).status,
    ).toBe('rejected');
    expect(request).not.toHaveBeenCalled();
  } finally {
    done.open();
  }
});
