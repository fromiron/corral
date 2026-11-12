import {
  type ControlEdge,
  type CorralDefinition,
  type CorralNode,
  CorralDefinition as Definition,
  type StartRunRequest,
  TERMINAL_RUN_STATUSES,
} from '@corral/contracts';
import {
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import {
  Coordinator,
  InMemoryRunStore,
  InProcessTransport,
  type RunProjection,
  waitForProjection,
} from '../src/index.ts';

// `onRunEnded` tells the host once per run, after the commit, when this process sees the run
// reach a terminal state. A run a previous process left open is closed by recovery unreported.

const settled = (p: RunProjection) => TERMINAL_RUN_STATUSES.has(p.status);
const startRequest = (definition: CorralDefinition, commandId: string): StartRunRequest => ({
  schemaVersion: '0.1',
  commandId,
  definition,
  mode: 'mock',
});
// The core package has no DOM or Node types; the test runs in Node.
const later = (globalThis as unknown as { setTimeout(fn: () => void, ms: number): unknown })
  .setTimeout;
const flush = () => new Promise<void>((resolve) => later(resolve, 20));

function setup(
  runEnded: (runId: string, coordinator: Coordinator) => void | Promise<void>,
  held: Record<string, Gate> = {},
  store = new InMemoryRunStore(),
) {
  const clock = new FakeClock();
  const coordinator: Coordinator = new Coordinator({
    clock,
    ids: new SequentialIdFactory(),
    timers: clock,
    store,
    onRunEnded: (runId) => runEnded(runId, coordinator) as void,
    agents: new ScriptedAgentAdapter({
      turns: 1,
      appendNotes: false,
      beforeReply: async (_turn, input) => held[input.nodeId]?.wait(),
    }),
  });
  return { coordinator, transport: new InProcessTransport(coordinator), store };
}

it('reports a successful end once, after the commit', async () => {
  const seen: { runId: string; status: string | undefined }[] = [];
  const { transport } = setup((runId, coordinator) => {
    seen.push({
      runId,
      status: coordinator.listRuns().find((run) => run.runId === runId)?.status,
    });
  });
  const { runId } = await transport.startRun(startRequest(linearCorral(['research']), 'cmd_ok'));
  await waitForProjection(transport, runId ?? '', settled);
  await flush();
  expect(seen).toEqual([{ runId, status: 'succeeded' }]);
});

it('reports a failed end and a cancelled end once each', async () => {
  const seen: string[] = [];
  const statuses: (string | undefined)[] = [];
  const gate = new Gate();
  const { transport } = setup(
    (runId, coordinator) => {
      seen.push(runId);
      statuses.push(coordinator.listRuns().find((run) => run.runId === runId)?.status);
    },
    { research: gate },
  );
  const failing = startRequest(linearCorral(['writer']), 'cmd_fail');
  const role = failing.definition.roles[0];
  if (role) role.allowedWorkTools = [];
  const failed = await transport.startRun(failing);
  expect((await waitForProjection(transport, failed.runId ?? '', settled)).status).toBe('failed');
  const cancelled = await transport.startRun(
    startRequest(linearCorral(['research']), 'cmd_cancel'),
  );
  await waitForProjection(transport, cancelled.runId ?? '', (p) => p.status === 'running');
  await transport.sendCommand({
    schemaVersion: '0.1',
    commandId: 'cmd_stop',
    runId: cancelled.runId ?? '',
    type: 'cancel',
    payload: { scope: { kind: 'run' }, reason: 'test' },
  });
  gate.open();
  expect((await waitForProjection(transport, cancelled.runId ?? '', settled)).status).toBe(
    'cancelled',
  );
  await flush();
  expect(seen).toEqual([failed.runId, cancelled.runId]);
  expect(statuses).toEqual(['failed', 'cancelled']);
});

it('a listener that throws or rejects does not break the run or later runs', async () => {
  let calls = 0;
  const { transport } = setup(() => {
    calls += 1;
    if (calls === 1) throw new Error('listener failed');
    return Promise.reject(new Error('listener rejected'));
  });
  const first = await transport.startRun(startRequest(linearCorral(['research']), 'cmd_1'));
  expect((await waitForProjection(transport, first.runId ?? '', settled)).status).toBe('succeeded');
  const second = await transport.startRun(startRequest(linearCorral(['research']), 'cmd_2'));
  expect((await waitForProjection(transport, second.runId ?? '', settled)).status).toBe(
    'succeeded',
  );
  await flush();
  expect(calls).toBe(2);
});

it('recovery of a run another process left open is not reported', async () => {
  const gate = new Gate();
  const first = setup(() => {}, { research: gate });
  const { runId } = await first.transport.startRun(
    startRequest(linearCorral(['research']), 'cmd_open'),
  );
  await waitForProjection(first.transport, runId ?? '', (p) => p.status === 'running');
  const seen: string[] = [];
  const second = setup((id) => void seen.push(id), {}, first.store);
  await flush();
  expect(second.coordinator.listRuns().find((run) => run.runId === runId)?.status).toBe(
    'interrupted',
  );
  expect(seen).toEqual([]);
  gate.open();
});

// A run that fails while another branch is still stopping commits again after it is terminal.
const base = Definition.parse(researchTeam);
const agent = (id: string, source?: string, roleId = 'writer'): CorralNode => ({
  id,
  type: 'agent',
  label: id,
  roleId,
  invocation: 'scheduled',
  inputBindings: source
    ? [{ kind: 'task_output', name: 'input', sourceNodeId: source }]
    : [{ kind: 'run_input', name: 'brief' }],
  outputName: 'draft',
});
let n = 0;
const edge = (source: string, sourcePort: string, target: string, targetPort = 'in') =>
  ({ id: `e${++n}`, source, sourcePort, target, targetPort }) as ControlEdge;

it('a run that keeps committing after it failed is reported once', async () => {
  const writer = base.roles.find((role) => role.id === 'writer');
  if (!writer) throw new Error('no writer role');
  const definition = Definition.parse({
    ...base,
    roles: [...base.roles, { ...writer, id: 'nowrite', allowedWorkTools: [] }],
    entryNodeId: 'p',
    nodes: [
      agent('p'),
      agent('a', 'p', 'nowrite'),
      agent('b', 'p'),
      { id: 'j', type: 'join', label: 'j', policy: 'all' },
      agent('m', 'p'),
      {
        id: 'output',
        type: 'output',
        label: 'output',
        inputBindings: [{ kind: 'task_output', name: 'final', sourceNodeId: 'm' }],
        requireApproval: false,
      },
    ],
    controlEdges: [
      edge('p', 'out', 'a'),
      edge('a', 'out', 'j'),
      edge('p', 'out', 'b'),
      edge('b', 'out', 'j'),
      edge('j', 'out', 'm'),
      edge('m', 'out', 'output'),
    ],
    capabilityLinks: [],
  });
  const gate = new Gate();
  const seen: string[] = [];
  const statuses: (string | undefined)[] = [];
  const { transport } = setup(
    (runId, coordinator) => {
      seen.push(runId);
      statuses.push(coordinator.listRuns().find((run) => run.runId === runId)?.status);
    },
    { b: gate },
  );
  const { runId, receipt } = await transport.startRun(startRequest(definition, 'cmd_parallel'));
  expect(receipt.error).toBeUndefined();
  const failed = await waitForProjection(transport, runId ?? '', settled);
  expect(failed.status).toBe('failed');
  const seqAtEnd = failed.lastSeq;
  gate.open();
  await flush();
  const after = (await transport.getSnapshot(runId ?? '')).projection;
  // The interesting case: something was committed after the terminal transition.
  expect(after.lastSeq).toBeGreaterThan(seqAtEnd);
  expect(seen).toEqual([runId]);
  expect(statuses).toEqual(['failed']);
});
