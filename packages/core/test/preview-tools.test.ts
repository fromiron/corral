import type { AgentHost, EffectiveHarnessSnapshot, ToolDescriptor } from '@corral/contracts';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { expect, it, vi } from 'vitest';
import type { CoordinatorDeps } from '../src/coordinator.ts';
import { Coordinator, InMemoryRunStore } from '../src/index.ts';

it('[TC-ABS-004-H] [TC-ABS-004-N] owned preview calls use Coordinator effects and cannot request code or upload tools', async () => {
  const cleanup = new Gate();
  const closeRun = vi.fn(async () => cleanup.wait());
  const clock = new FakeClock(),
    started = new Gate(),
    done = new Gate(),
    store = new InMemoryRunStore();
  const names = ['preview_file', 'preview_app', 'preview_action'];
  const descriptors: ToolDescriptor[] = names.map((name) => ({
    source: 'corral',
    name,
    schemaHash: 'a'.repeat(64),
    exposure: 'direct',
    sideEffect: 'external',
  }));
  const harness: EffectiveHarnessSnapshot = {
    binding: { profileId: 'preview', revision: 1 },
    snapshotHash: 'b'.repeat(64),
    piVersion: '1.3.0',
    policyRevision: 1,
    policy: 'trusted-native',
    resources: [],
    allowedTools: names,
    tools: descriptors,
    diagnostics: [],
  };
  const execute = vi.fn<NonNullable<CoordinatorDeps['previewTools']>['execute']>(async () => ({
    leaseId: 'preview_one',
    kind: 'file',
  }));
  let host!: AgentHost;
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    store,
    files: { available: () => true, execute: async () => ({}) },
    harnesses: { resolve: () => harness },
    previewTools: { execute, closeRun, closeExecution: async () => {} },
    agents: {
      start: async (_input, h) => {
        host = h;
        started.open();
        return {
          cancel: async () => done.open(),
          waitForSettlement: async () => {
            await done.wait();
            return { outcome: 'cancelled' as const };
          },
        };
      },
    },
  });
  const definition = linearCorral(['writer']),
    role = definition.roles[0]!;
  role.harness = harness.binding;
  role.allowedWorkTools = ['read_file', 'preview_file', 'preview_app', 'preview_action'];
  const result = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'preview_start',
    definition,
    mode: 'mock',
    permissionMode: 'auto',
  });
  if (!result.runId) throw new Error(result.receipt.error?.message);
  await started.wait();
  await host.reportHarness!({
    ok: true,
    snapshotHash: harness.snapshotHash,
    tools: descriptors,
    diagnostics: [],
  });
  expect((await host.invokeTool({ name: 'preview_file', args: { path: 'index.html' } })).ok).toBe(
    true,
  );
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.calls[0]?.[0]).toMatchObject({
    runId: result.runId,
    attemptNo: 1,
    name: 'preview_file',
  });
  expect(
    store
      .readEvents(result.runId, 0)
      .some((event) => event.type === 'tool.finished' && event.payload.resultRef),
  ).toBe(true);
  for (const args of [
    { leaseId: 'preview_one', tool: 'browser_run_code', args: { code: 'process.exit()' } },
    { leaseId: 'preview_one', tool: 'browser_take_screenshot', args: { filename: 'outside.png' } },
    { leaseId: 'preview_one', tool: 'browser_wait_for', args: { time: 20 } },
  ])
    expect((await host.invokeTool({ name: 'preview_action', args })).ok).toBe(false);
  expect(execute).toHaveBeenCalledTimes(1);
  coordinator.submit({
    schemaVersion: '0.1',
    commandId: 'close_previews',
    runId: result.runId,
    type: 'cancel',
    payload: { scope: { kind: 'run' }, reason: 'stop preview' },
  });
  await vi.waitFor(() => expect(closeRun).toHaveBeenCalledWith(result.runId));
  expect(coordinator.getSnapshot(result.runId).projection.status).not.toBe('cancelled');
  cleanup.open();
  const runId = result.runId;
  await vi.waitFor(() =>
    expect(coordinator.getSnapshot(runId).projection.status).toBe('cancelled'),
  );
});
