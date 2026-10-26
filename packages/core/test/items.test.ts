import type { AgentStartInput, ToolOutcome } from '@corral/contracts';
import {
  collaborationCorral,
  FakeClock,
  Gate,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { expect, it } from 'vitest';
import { Coordinator, InProcessTransport, waitForProjection } from '../src/index.ts';

const ended = (p: { status: string }) => ['succeeded', 'failed', 'cancelled'].includes(p.status);
const tasks = [
  { targetNodeId: 'helper', brief: 'Only alpha' },
  { targetNodeId: 'helper', brief: 'Only beta' },
];
function setup(
  options: {
    gate?: Gate;
    fail?: boolean;
    nested?: boolean;
    parallelFirst?: boolean;
    harness?: boolean;
  } = {},
) {
  const definition = collaborationCorral();
  definition.input.brief = 'PRIVATE PARENT BRIEF';
  definition.limits.maxModelConcurrency = 1;
  if (options.harness) definition.roles[0]!.harness = { profileId: 'items', revision: 1 };
  const helper = definition.roles.find((role) => role.id === 'helper')!;
  helper.allowedCollaborationTools.push('spawn_subagents');
  definition.capabilityLinks.push({
    id: 'nested',
    kind: 'delegate',
    sourceNodeId: 'helper',
    targetNodeId: 'helper',
  });
  const started: AgentStartInput[] = [];
  const outcomes: ToolOutcome[] = [];
  let firstArtifact = '';
  const scripted = new ScriptedAgentAdapter({
    turns: 1,
    collaborate: false,
    appendNotes: false,
    reply: () => 'done',
    script: async (input, host) => {
      if (input.nodeId === 'research') {
        if (options.parallelFirst)
          await host.invokeTool({ name: 'spawn_subagents', args: { tasks: [tasks[0]] } });
        outcomes.push(
          await host.invokeTool({ name: 'spawn_subagents', args: { mode: 'items', tasks } }),
        );
        if (options.harness) {
          const written = await host.invokeTool({ name: 'write_artifact', args: { text: 'done' } });
          if (!written.ok) return { outcome: 'failed', error: written.error.message };
          await host.invokeTool({
            name: 'submit_result',
            args: { artifactVersionIds: [written.result.artifactVersionId] },
          });
          return { outcome: 'succeeded' };
        }
      }
      if (input.nodeId === 'helper') {
        if (options.nested)
          outcomes.push(
            await host.invokeTool({
              name: 'spawn_subagents',
              args: { mode: 'items', tasks: [tasks[0]] },
            }),
          );
        await options.gate?.wait();
        if (options.fail) return { outcome: 'failed', error: 'item failure' };
        if (firstArtifact) {
          const read = await host.invokeTool({
            name: 'read_artifact',
            args: { artifactVersionId: firstArtifact },
          });
          expect(read.ok).toBe(false);
        }
        const write = await host.invokeTool({
          name: 'write_artifact',
          args: { text: input.inputs.map((i) => i.text).join('\n') },
        });
        if (!write.ok) return { outcome: 'failed', error: write.error.message };
        firstArtifact = write.result.artifactVersionId as string;
        await host.invokeTool({
          name: 'submit_result',
          args: { artifactVersionIds: [firstArtifact] },
        });
        return { outcome: 'succeeded' };
      }
      return null;
    },
  });
  const clock = new FakeClock();
  const transport = new InProcessTransport(
    new Coordinator({
      clock,
      timers: clock,
      ids: new SequentialIdFactory(),
      ...(options.harness
        ? {
            harnesses: {
              resolve: () => ({
                binding: { profileId: 'items', revision: 1 },
                snapshotHash: 'a'.repeat(64),
                piVersion: '1.3.0',
                policyRevision: 1,
                policy: 'strict' as const,
                resources: [],
                allowedTools: ['spawn_subagents', 'write_artifact', 'submit_result'],
                tools: [],
                diagnostics: [],
              }),
            },
          }
        : {}),
      agents: {
        async start(input, host) {
          started.push(input);
          if (input.harness)
            await host.reportHarness!({
              ok: true,
              snapshotHash: input.harness.snapshotHash,
              diagnostics: [],
              tools: input.harness.allowedTools.map((name) => ({
                name,
                source: 'corral',
                schemaHash: 'b'.repeat(64),
                exposure: 'direct',
                sideEffect: 'none',
              })),
            });
          return scripted.start(input, host);
        },
      },
    }),
  );
  return { transport, definition, started, outcomes };
}
it('rechecks each item against the loaded harness tool registry', async () => {
  const s = setup({ harness: true });
  await waitForProjection(s.transport, await start(s), ended);
  expect(s.outcomes[0]).toMatchObject({ ok: true, result: { remaining: 0 } });
  expect(s.started.filter((i) => i.nodeId === 'helper')).toHaveLength(2);
});
async function start(s: ReturnType<typeof setup>) {
  const r = await s.transport.startRun({
    schemaVersion: '0.1',
    commandId: 'start_items',
    definition: s.definition,
    mode: 'mock',
  });
  if (!r.runId) throw new Error(JSON.stringify(r.receipt));
  return r.runId;
}
it('runs fresh item tasks serially with isolated contexts and shared parent budget', async () => {
  const gate = new Gate();
  const s = setup({ gate });
  const id = await start(s);
  await waitForProjection(s.transport, id, (p) => (p.nodeExecutions.helper?.length ?? 0) > 0);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(s.started.filter((i) => i.nodeId === 'helper')).toHaveLength(1);
  gate.open();
  const p = await waitForProjection(s.transport, id, ended);
  expect(p.status).toBe('succeeded');
  const children = s.started.filter((i) => i.nodeId === 'helper');
  expect(children).toHaveLength(2);
  expect(new Set(children.map((i) => i.taskId)).size).toBe(2);
  for (const [index, child] of children.entries()) {
    expect(child.item).toMatchObject({ index: index + 1, total: 2 });
    expect(child.inputs.map((i) => i.text).join('\n')).toContain(tasks[index]!.brief);
    expect(child.inputs.map((i) => i.text).join('\n')).not.toContain('PRIVATE PARENT');
    expect(child.inputs.map((i) => i.text).join('\n')).not.toContain(tasks[1 - index]!.brief);
    expect(child.depth).toBe(1);
    expect(p.executions[child.executionId]?.item).toEqual(child.item);
  }
  expect(s.outcomes[0]).toMatchObject({
    ok: true,
    result: { remaining: 0, tasks: [{ status: 'completed' }, { status: 'completed' }] },
  });
});
it('ends the batch after one failure without starting remaining items', async () => {
  const s = setup({ fail: true });
  const id = await start(s);
  await waitForProjection(s.transport, id, ended);
  expect(s.started.filter((i) => i.nodeId === 'helper')).toHaveLength(1);
  expect(s.outcomes[0]).toMatchObject({
    ok: true,
    result: { remaining: 1, tasks: [{ status: 'failed' }] },
  });
});
it('parent cancellation during an item never starts the next item', async () => {
  const gate = new Gate();
  const s = setup({ gate });
  const id = await start(s);
  await waitForProjection(s.transport, id, (p) => (p.nodeExecutions.helper?.length ?? 0) > 0);
  await s.transport.sendCommand({
    schemaVersion: '0.1',
    commandId: 'cancel_items',
    runId: id,
    type: 'cancel',
    payload: { scope: { kind: 'run' }, reason: 'test' },
  });
  gate.open();
  const p = await waitForProjection(s.transport, id, ended);
  expect(p.status).toBe('cancelled');
  expect(s.started.filter((i) => i.nodeId === 'helper')).toHaveLength(1);
});
it('pause prevents the next item until a revision-matched resume', async () => {
  const gate = new Gate(),
    s = setup({ gate }),
    id = await start(s);
  await waitForProjection(s.transport, id, (p) => (p.nodeExecutions.helper?.length ?? 0) > 0);
  const paused = await s.transport.sendCommand({
    schemaVersion: '0.1',
    commandId: 'pause_items',
    runId: id,
    type: 'pause',
    payload: { scope: 'run' },
  });
  expect(paused.status).not.toBe('rejected');
  gate.open();
  const p = await waitForProjection(s.transport, id, (p) => p.status === 'paused');
  expect(s.started.filter((i) => i.nodeId === 'helper')).toHaveLength(1);
  await s.transport.sendCommand({
    schemaVersion: '0.1',
    commandId: 'resume_items',
    runId: id,
    expectedControlRevision: p.controlRevision,
    type: 'resume',
    payload: { scope: 'run' },
  });
  expect((await waitForProjection(s.transport, id, ended)).status).toBe('succeeded');
  expect(s.started.filter((i) => i.nodeId === 'helper')).toHaveLength(2);
});
it('rejects nested item batches and a batch beside an active sibling', async () => {
  const nested = setup({ nested: true });
  await waitForProjection(nested.transport, await start(nested), ended);
  expect(nested.outcomes.filter((o) => !o.ok)).toHaveLength(2);
  const gate = new Gate();
  const parallel = setup({ gate, parallelFirst: true });
  const id = await start(parallel);
  await waitForProjection(
    parallel.transport,
    id,
    (p) => (p.nodeExecutions.helper?.length ?? 0) > 0,
  );
  for (let i = 0; i < 100; i++) await Promise.resolve();
  gate.open();
  await waitForProjection(parallel.transport, id, ended);
  expect(parallel.outcomes[0]).toMatchObject({ ok: false, error: { code: 'CAPABILITY_DENIED' } });
  expect(parallel.started.filter((i) => i.nodeId === 'helper')).toHaveLength(1);
});
