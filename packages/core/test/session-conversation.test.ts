import type { AgentStartInput } from '@corral/contracts';
import {
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  Coordinator,
  exportRunArchive,
  InMemoryRunStore,
  InProcessTransport,
  openRunArchive,
  SPEC_HARD_CAPS,
  waitForProjection,
} from '../src/index.ts';

// a session follow-up carries the session's earlier requests and answers as turns the
// Coordinator copies from its own records, instead of "Start from this earlier version".

const SESSION = 'session_chat';
const ended = (status: string) => ['succeeded', 'failed', 'cancelled'].includes(status);

function setup(
  options: { maxArtifactBytes?: number; gate?: Gate; namespace?: string } = {},
  store = new InMemoryRunStore(),
) {
  const starts: AgentStartInput[] = [];
  const coordinator = new Coordinator({
    store,
    clock: new FakeClock(),
    // A second Coordinator on the same store needs its own IDs.
    ids: new SequentialIdFactory(options.namespace),
    policy: {
      ...SPEC_HARD_CAPS,
      maxArtifactBytes: options.maxArtifactBytes ?? SPEC_HARD_CAPS.maxArtifactBytes,
    },
    agents: new ScriptedAgentAdapter({
      turns: 1,
      appendNotes: false,
      reply: (_turn, input) => `Answer to: ${input.inputs.find((i) => i.name === 'brief')?.text}`,
      beforeReply: async (turn, input) => {
        if (turn === 1) starts.push(JSON.parse(JSON.stringify(input)) as AgentStartInput);
        if (input.inputs.some((i) => i.text === 'HOLD')) await options.gate?.wait();
      },
      script: async (input) =>
        input.inputs.some((i) => i.text === 'FAIL')
          ? { outcome: 'failed', error: 'scripted' }
          : null,
    }),
  });
  return { coordinator, transport: new InProcessTransport(coordinator), starts, store };
}

type Setup = ReturnType<typeof setup>;

function begin(
  s: Setup,
  commandId: string,
  brief: string,
  extra: Record<string, unknown> = {},
  agents = ['writer'],
) {
  const definition = linearCorral(agents);
  definition.input = { ...definition.input, brief };
  return s.coordinator.startRun({
    schemaVersion: '0.1',
    commandId,
    definition,
    mode: 'mock',
    sessionId: SESSION,
    ...extra,
  } as Parameters<Coordinator['startRun']>[0]);
}

async function turn(
  s: Setup,
  commandId: string,
  brief: string,
  extra: Record<string, unknown> = {},
  agents?: string[],
) {
  const result = begin(s, commandId, brief, extra, agents);
  if (!result.runId) return { result, projection: null, runId: '' };
  const projection = await waitForProjection(s.transport, result.runId, (p) => ended(p.status));
  return { result, projection, runId: result.runId };
}

const startOf = (s: Setup, runId: string) => s.starts.filter((input) => input.runId === runId);
const briefOf = (input: AgentStartInput | undefined) =>
  input?.inputs.find((i) => i.name === 'brief')?.text;
const started = (s: Setup, runId: string) =>
  s.store.readEvents(runId, 0)[0]?.payload as Record<string, unknown>;

describe('session conversation continuity', () => {
  it('a follow-up carries earlier requests and answers as turns and keeps its brief as typed', async () => {
    const s = setup();
    const first = await turn(s, 'cmd_first', '피보나치 수열 설명해봐');
    const firstAnswer = first.projection?.output?.artifactVersionIds[0] ?? '';
    const answerText = s.coordinator.getArtifactText(first.runId, firstAnswer);
    expect(answerText).toBe('Answer to: 피보나치 수열 설명해봐');

    const second = await turn(s, 'cmd_second', '하이', {
      conversation: { throughRunId: first.runId },
    });
    expect(second.projection?.status).toBe('succeeded');
    const [input] = startOf(s, second.runId);
    // The new request is exactly what the person typed: no copied start point.
    expect(briefOf(input)).toBe('하이');
    expect(JSON.stringify(input?.inputs)).not.toContain('Start from this earlier version');
    expect(input?.conversation).toEqual({
      turns: [
        {
          runId: first.runId,
          request: '피보나치 수열 설명해봐',
          answer: answerText,
          status: 'succeeded',
        },
      ],
      omittedTurns: 0,
    });
    expect(started(s, second.runId).conversation).toMatchObject({
      throughRunId: first.runId,
      turns: [{ runId: first.runId, artifactVersionId: firstAnswer }],
      omittedTurns: 0,
    });
    expect(second.projection?.startedFrom).toBeNull();

    // The next follow-up renders the same first turn again, then appends the second.
    const third = await turn(s, 'cmd_third', '고마워', {
      conversation: { throughRunId: second.runId },
    });
    const [later] = startOf(s, third.runId);
    expect(later?.conversation?.turns.map((t) => [t.request, t.answer])).toEqual([
      ['피보나치 수열 설명해봐', answerText],
      ['하이', 'Answer to: 하이'],
    ]);
    expect(later?.conversation?.turns[0]).toEqual(input?.conversation?.turns[0]);
  });

  it('the recorded request of an earlier start-from run is sent without its copied start point', async () => {
    const s = setup();
    const first = await turn(s, 'cmd_a', 'Write a haiku.');
    const legacy = await turn(s, 'cmd_legacy', 'Shorter, please.', {
      startFrom: {
        runId: first.runId,
        artifactVersionId: first.projection?.output?.artifactVersionIds[0] ?? '',
      },
    });
    expect(briefOf(startOf(s, legacy.runId)[0])).toContain('Start from this earlier version');
    const next = await turn(s, 'cmd_next', 'Thanks.', {
      conversation: { throughRunId: legacy.runId },
    });
    expect(startOf(s, next.runId)[0]?.conversation?.turns.map((t) => t.request)).toEqual([
      'Write a haiku.',
      'Shorter, please.',
    ]);
  });

  it('a request without a result contributes its status, and later agents get no turns', async () => {
    const s = setup();
    const failed = await turn(s, 'cmd_fail', 'FAIL');
    expect(failed.projection?.status).toBe('failed');
    const next = await turn(
      s,
      'cmd_after',
      'Try again.',
      { conversation: { throughRunId: failed.runId } },
      ['writer', 'editor'],
    );
    const [writer, editor] = startOf(s, next.runId);
    expect(writer?.conversation?.turns).toEqual([
      { runId: failed.runId, request: 'FAIL', answer: null, status: 'failed' },
    ]);
    expect(started(s, next.runId).conversation).toMatchObject({
      turns: [{ runId: failed.runId, artifactVersionId: null }],
    });
    // The editor binds the writer's output, not the brief.
    expect(editor?.nodeId).toBe('editor');
    expect(editor?.conversation).toBeUndefined();
  });

  it('oversized history drops the oldest turns and then the newest answer', async () => {
    const s = setup({ maxArtifactBytes: 60 });
    const one = await turn(s, 'cmd_one', 'first question');
    const two = await turn(s, 'cmd_two', 'second question');
    const three = await turn(s, 'cmd_three', 'third', {
      conversation: { throughRunId: two.runId },
    });
    expect(startOf(s, three.runId)[0]?.conversation).toEqual({
      turns: [
        {
          runId: two.runId,
          request: 'second question',
          answer: 'Answer to: second question',
          status: 'succeeded',
        },
      ],
      omittedTurns: 1,
    });
    expect(one.runId).not.toBe('');

    const tight = setup({ maxArtifactBytes: 30, namespace: 'tight_' }, s.store);
    const four = await turn(tight, 'cmd_four', 'fourth', {
      conversation: { throughRunId: two.runId },
    });
    expect(startOf(tight, four.runId)[0]?.conversation).toEqual({
      turns: [
        {
          runId: two.runId,
          request: 'second question',
          answer: null,
          status: 'succeeded',
          answerOmitted: true,
        },
      ],
      omittedTurns: 1,
    });
  });

  it('refuses a conversation it cannot read from this session, and starts nothing', async () => {
    const gate = new Gate();
    const s = setup({ gate });
    const first = await turn(s, 'cmd_first', 'hello');
    const other = s.coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_other_session',
      definition: linearCorral(['writer']),
      mode: 'mock',
      sessionId: 'session_other',
    });
    await waitForProjection(s.transport, other.runId!, (p) => ended(p.status));
    const active = begin(s, 'cmd_active', 'HOLD');
    expect(active.runId).not.toBeNull();
    const before = s.coordinator.listRuns().length;
    const refused = [
      begin(s, 'cmd_missing', 'x', { conversation: { throughRunId: 'run_missing' } }),
      begin(s, 'cmd_foreign', 'x', { conversation: { throughRunId: other.runId } }),
      begin(s, 'cmd_unended', 'x', { conversation: { throughRunId: active.runId } }),
      s.coordinator.startRun({
        schemaVersion: '0.1',
        commandId: 'cmd_no_session',
        definition: linearCorral(['writer']),
        mode: 'mock',
        conversation: { throughRunId: first.runId },
      } as Parameters<Coordinator['startRun']>[0]),
    ];
    for (const result of refused) {
      expect(result.runId).toBeNull();
      expect(result.receipt.error?.code).toBe('TARGET_NOT_FOUND');
    }
    expect(s.coordinator.listRuns()).toHaveLength(before);
    gate.open();
    await waitForProjection(s.transport, active.runId!, (p) => ended(p.status));
  });

  it('a repeated start returns the same run, and a changed copy fails private export checks', async () => {
    const s = setup();
    const first = await turn(s, 'cmd_first', 'hello');
    const request = { conversation: { throughRunId: first.runId } };
    const second = await turn(s, 'cmd_second', 'again', request);
    const repeat = begin(s, 'cmd_second', 'again', request);
    expect(repeat.runId).toBe(second.runId);
    expect(startOf(s, second.runId)).toHaveLength(1);

    const archive = exportRunArchive(s.store, second.runId, { privateTranscript: true });
    if (archive.visibility !== 'private') throw new Error('expected a private archive');
    expect(archive.artifacts.session_conversation).toContain('hello');
    expect(() => openRunArchive(archive)).not.toThrow();
    const tampered = JSON.parse(JSON.stringify(archive)) as typeof archive;
    tampered.artifacts.session_conversation = (
      tampered.artifacts.session_conversation ?? ''
    ).replace('hello', 'HELLO');
    expect(() => openRunArchive(tampered)).toThrow(/conversation/);
  });
});
