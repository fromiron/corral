import {
  type ControlEdge,
  type CorralDefinition,
  type CorralNode,
  CorralDefinition as Definition,
  type RunEvent,
  type VerificationReport,
} from '@corral/contracts';
import { FakeClock, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it, vi } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import {
  Coordinator,
  type CoordinatorDeps,
  compileDefinition,
  InMemoryRunStore,
  InProcessTransport,
  type RunProjection,
  waitForProjection,
} from '../src/index.ts';

// The check Decision (docs/specs/features/team-graph.md, "check 실행").

const base = Definition.parse(researchTeam);
const agent = (id: string, source?: string): CorralNode => ({
  id,
  type: 'agent',
  label: id,
  roleId: 'writer',
  invocation: 'scheduled',
  inputBindings: source
    ? [{ kind: 'task_output', name: 'draft', sourceNodeId: source }]
    : [{ kind: 'run_input', name: 'brief' }],
  outputName: 'draft',
});
const edge = (id: string, source: string, sourcePort: string, target: string) =>
  ({ id, source, sourcePort, target, targetPort: 'in' }) as ControlEdge;

/** w → check(types, tests) → pass: ship / fail: fix → output */
function team(): CorralDefinition {
  return Definition.parse({
    ...base,
    entryNodeId: 'w',
    capabilityLinks: [],
    nodes: [
      agent('w'),
      {
        id: 'check',
        type: 'decision',
        label: 'check',
        mode: 'check',
        checkIds: ['types', 'tests'],
        inputBindings: [{ kind: 'task_output', name: 'draft', sourceNodeId: 'w' }],
      },
      agent('ship', 'w'),
      agent('fix', 'w'),
      {
        id: 'output',
        type: 'output',
        label: 'output',
        inputBindings: ['ship', 'fix'].map((id) => ({
          kind: 'task_output' as const,
          name: id,
          sourceNodeId: id,
          optional: true,
        })),
        requireApproval: false,
      },
    ],
    controlEdges: [
      edge('e1', 'w', 'out', 'check'),
      edge('e2', 'check', 'pass', 'ship'),
      edge('e3', 'check', 'fail', 'fix'),
      edge('e4', 'ship', 'out', 'output'),
      edge('e5', 'fix', 'out', 'output'),
    ],
  });
}

type Outcome = 'pass' | 'fail' | 'error' | 'stale';

/** Checks answer from a script per command, in order; a missing answer is `pass`. */
function runtime(
  script: Record<string, Outcome[]>,
  options: {
    sessionId?: string | null;
    trusted?: boolean;
    files?: Partial<NonNullable<CoordinatorDeps['files']>>;
    projectChecks?: (sessionId: string, checkIds: string[]) => unknown;
  } = {},
) {
  const clock = new FakeClock();
  const store = new InMemoryRunStore();
  let n = 0;
  const runCheck = vi.fn<NonNullable<NonNullable<CoordinatorDeps['files']>['runCheck']>>(
    async (input, plan) => {
      const outcome = script[input.commandId]?.shift() ?? 'pass';
      const report: VerificationReport = {
        verificationId: `check_${++n}`,
        owner: {
          kind: 'execution',
          runId: input.runId,
          executionId: input.executionId,
          attemptNo: input.attemptNo,
          effectId: input.effectId,
        },
        sessionId: 'session',
        commandId: input.commandId,
        configRevision: 1,
        fingerprint: plan.fingerprint,
        tree: plan.tree,
        state: outcome === 'error' ? 'error' : 'completed',
        verdict:
          outcome === 'pass' || outcome === 'stale'
            ? 'pass'
            : outcome === 'fail'
              ? 'fail'
              : 'inconclusive',
        exitCode: outcome === 'fail' ? 1 : 0,
        signal: null,
        timedOut: false,
        cleanupConfirmed: true,
        targetUnchanged: outcome !== 'stale',
        durationMs: 1,
        startedAt: '2026-10-18T00:00:00.000Z',
        endedAt: '2026-10-18T00:00:00.001Z',
        retainUntil: '2026-10-25T00:00:00.000Z',
        output: { text: outcome, bytes: 1, hash: 'e'.repeat(64), truncated: false },
      };
      return { ...report, stale: outcome === 'stale' };
    },
  );
  const projectChecks = vi.fn(
    options.projectChecks ??
      ((_session: string, checkIds: string[]) => ({
        projectId: 'project',
        revision: 1,
        hash: 'b'.repeat(64),
        checkIds,
        lspServerIds: [],
      })),
  );
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    store,
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({ turns: 1, collaborate: false, appendNotes: false }),
    harnesses: {
      resolve: () => {
        throw new Error('no role harness in these tests');
      },
      projectChecks,
    } as unknown as NonNullable<CoordinatorDeps['harnesses']>,
    files: {
      available: () => true,
      execute: async () => ({}),
      planCheck: async (input) => ({
        commandId: input.commandId,
        name: input.commandId,
        argv: ['node', `${input.commandId}.mjs`],
        timeoutMs: 1000,
        configRevision: 1,
        fingerprint: 'd'.repeat(64),
        tree: '1'.repeat(40),
        trusted: options.trusted ?? true,
      }),
      runCheck,
      ...options.files,
    },
  });
  const transport = new InProcessTransport(coordinator);
  const start = () =>
    coordinator.startRun({
      schemaVersion: '0.1',
      commandId: `start_${Math.random()}`,
      definition: team(),
      mode: 'mock',
      ...(options.sessionId === null ? {} : { sessionId: options.sessionId ?? 'session' }),
    });
  return { coordinator, transport, store, runCheck, projectChecks, start };
}

const finished = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);
const pending = (p: RunProjection) =>
  p.status === 'awaiting_user'
    ? (Object.values(p.approvals).find((a) => a.status === 'pending') ?? null)
    : null;
const attempts = (p: RunProjection, nodeId: string) =>
  (p.nodeExecutions[nodeId] ?? []).map((id) => p.executions[id]!);
const branches = (events: RunEvent[]) =>
  events.flatMap((e) =>
    e.type === 'workflow.branch_selected' && e.payload.nodeId === 'check' ? [e.payload] : [],
  );

async function started(s: ReturnType<typeof runtime>) {
  const result = s.start();
  if (!result.runId) throw new Error(JSON.stringify(result.receipt.error));
  return result.runId;
}

async function answer(
  s: ReturnType<typeof runtime>,
  runId: string,
  decision: 'approve' | 'reject',
  kind: string,
) {
  const waiting = await waitForProjection(s.transport, runId, (p) => pending(p) !== null);
  const approval = pending(waiting);
  expect(approval?.kind).toBe(kind);
  return s.transport.sendCommand({
    schemaVersion: '0.1',
    commandId: `cmd_${Math.random()}`,
    runId,
    type: 'resolve_approval',
    expectedControlRevision: waiting.controlRevision,
    payload: {
      approvalId: approval?.approvalId ?? '',
      decision,
      subjectVersionId: approval?.subjectVersionIds[0] ?? '',
    },
  });
}

describe('check decision', () => {
  it('compiles a check decision as runnable', () => {
    expect(compileDefinition(team()).ok).toBe(true);
  });

  it('runs every check in its own execution and takes fail when one fails', async () => {
    const s = runtime({ types: ['pass'], tests: ['fail'] });
    const runId = await started(s);
    const final = await waitForProjection(s.transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(s.runCheck.mock.calls.map(([input]) => input.commandId)).toEqual(['types', 'tests']);
    // The checks belong to the check node's own execution, with the pinned selection.
    const [checker] = attempts(final, 'check');
    expect(attempts(final, 'check')).toHaveLength(1);
    expect(s.runCheck.mock.calls[0]?.[0]).toMatchObject({
      executionId: checker?.executionId,
      selection: { projectId: 'project', checkIds: ['types', 'tests'] },
    });
    expect(s.projectChecks).toHaveBeenCalledWith('session', ['types', 'tests']);
    expect(attempts(final, 'fix')).toHaveLength(1);
    expect(attempts(final, 'ship')).toHaveLength(0);
    const [selected] = branches(s.store.readEvents(runId, 0));
    expect(selected).toMatchObject({
      mode: 'check',
      selectedPort: 'fail',
      reasonCode: 'check_verdict',
    });
    expect(selected?.evidenceRefs.filter((r) => r.kind === 'check').map((r) => r.id)).toEqual([
      'check_1',
      'check_2',
    ]);
  });

  it('takes pass when every check passes on an unchanged tree', async () => {
    const s = runtime({});
    const runId = await started(s);
    const final = await waitForProjection(s.transport, runId, finished);
    expect(final.status).toBe('succeeded');
    expect(attempts(final, 'ship')).toHaveLength(1);
    expect(branches(s.store.readEvents(runId, 0))[0]?.selectedPort).toBe('pass');
  });

  it('a real failure wins over a check without a verdict', async () => {
    const s = runtime({ types: ['error'], tests: ['fail'] });
    const runId = await started(s);
    const final = await waitForProjection(s.transport, runId, finished);
    expect(attempts(final, 'fix')).toHaveLength(1);
  });

  it('asks to run again when no check failed but one has no verdict, then runs the next attempt', async () => {
    const s = runtime({ types: ['stale', 'pass'] });
    const runId = await started(s);
    expect((await answer(s, runId, 'approve', 'check')).status).toBe('applied');
    const final = await waitForProjection(s.transport, runId, finished);
    expect(final.status).toBe('succeeded');
    const [first, second] = attempts(final, 'check');
    expect(second?.taskId).toBe(first?.taskId);
    expect(second?.attemptNo).toBe(2);
    expect(attempts(final, 'ship')).toHaveLength(1);
    expect(branches(s.store.readEvents(runId, 0)).map((b) => b.selectedPort)).toEqual(['pass']);
  });

  it('cancels the run when the person declines to run the checks again', async () => {
    const s = runtime({ tests: ['error'] });
    const runId = await started(s);
    await answer(s, runId, 'reject', 'check');
    const final = await waitForProjection(s.transport, runId, finished);
    expect(final.status).toBe('cancelled');
    expect(final.statusReason).toBe('rejected: check');
    expect(branches(s.store.readEvents(runId, 0))).toEqual([]);
  });

  it('asks before launching an untrusted check, as for any check', async () => {
    const s = runtime({}, { trusted: false });
    const runId = await started(s);
    const waiting = await waitForProjection(s.transport, runId, (p) => pending(p) !== null);
    const launch = pending(waiting);
    expect(launch?.tool).toMatchObject({
      purpose: 'check',
      executionId: attempts(waiting, 'check')[0]?.executionId,
    });
  });

  it('refuses to start without a session, an unregistered check or a check runner', () => {
    const refused = (s: ReturnType<typeof runtime>) => {
      const result = s.start();
      expect(result.runId).toBeNull();
      return result.receipt.error?.code;
    };
    expect(refused(runtime({}, { sessionId: null }))).toBe('CAPABILITY_DENIED');
    expect(
      refused(
        runtime(
          {},
          {
            projectChecks: () => {
              throw new Error('selected project tool is not registered');
            },
          },
        ),
      ),
    ).toBe('CAPABILITY_DENIED');
    expect(refused(runtime({}, { files: { runCheck: undefined } }))).toBe('CAPABILITY_DENIED');
  });
});
