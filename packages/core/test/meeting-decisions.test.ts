import { type MeetingConfig, MeetingState } from '@corral/contracts';
import { FakeClock } from '@corral/testkit';
import { describe, expect, it, vi } from 'vitest';
import { createKeyValueCorralRepository } from '../src/index.ts';
import {
  activeMeetingDecision,
  MeetingDecisionsService,
  recordMeetingMinutes,
} from '../src/meeting-decisions.ts';
import type { RuntimeTransport } from '../src/transport.ts';

const config: MeetingConfig = {
  version: 1,
  participants: [
    { participantId: 'a', name: 'Architect', prompt: 'Plan.', modelProfile: 'model' },
    { participantId: 'b', name: 'Builder', prompt: 'Build.', modelProfile: 'model' },
  ],
  secretary: { modelProfile: 'model' },
};
const content = {
  goal: 'Keep one service',
  scope: ['API'],
  excludedScope: ['UI'],
  acceptanceCriteria: ['Existing calls work'],
  remainingDissent: ['Builder prefers two services'],
  evidence: ['Round one'],
  risks: ['Coupling'],
  actions: ['Keep the service', 'Check latency'],
  rejectedAlternatives: ['Split services'],
};
const document = {
  issues: ['Split the service?'],
  claims: [{ roundId: 'r1', participantId: 'a', text: 'Keep one service.' }],
  agreements: [
    { text: 'Keep the API compatible.', supporters: [{ roundId: 'r1', participantId: 'a' }] },
  ],
  remainingDissent: [{ roundId: 'r1', participantId: 'b', text: 'Split the service.' }],
  unverifiedFacts: ['Actual latency'],
  candidates: [{ candidateId: 'keep', content }],
};
async function setup(text = JSON.stringify(document), failedParticipant = false) {
  const clock = new FakeClock();
  const data = new Map<string, string>();
  const repository = createKeyValueCorralRepository(
    {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
      removeItem: (key) => {
        data.delete(key);
      },
    },
    { clock, newCorralId: () => 'corral', newSessionId: () => 'meeting' },
  );
  const created = await repository.createSession({
    projectId: 'default',
    title: 'Meeting',
    meeting: config,
  });
  if (!created.ok) throw new Error(created.message);
  const base = {
    commandId: 'c1',
    mode: 'mock' as const,
    message: 'Discuss',
    basedOnRoundId: null,
    rebuttalNo: null,
    createdAt: clock.nowIso(),
    stoppedAt: null,
  };
  await repository.updateSession('meeting', {
    expectedRevision: created.session.revision,
    meeting: {
      config,
      queued: null,
      rounds: [
        {
          ...base,
          roundId: 'r1',
          kind: 'all',
          participantIds: ['a', 'b'],
          answers: [
            { participantId: 'a', runId: 'run_a', state: 'started', detail: null },
            { participantId: 'b', runId: 'run_b', state: 'started', detail: null },
          ],
        },
        {
          ...base,
          roundId: 'r2',
          commandId: 'c2',
          kind: 'secretary',
          participantIds: ['secretary'],
          answers: [{ participantId: 'secretary', runId: 'run_s', state: 'started', detail: null }],
        },
      ],
    },
  });
  const transport = {
    getSnapshot: vi.fn(async (runId: string) => ({
      projection: {
        status: failedParticipant && runId === 'run_b' ? 'failed' : 'succeeded',
        output: { artifactVersionIds: ['artifact'] },
      },
    })),
    getArtifactText: vi.fn(async () => text),
    startRun: vi.fn(),
  } as unknown as RuntimeTransport;
  let next = 0;
  const service = new MeetingDecisionsService({
    repository,
    clock,
    newDecisionId: () => `decision_${++next}`,
  });
  const state = async () => {
    const meeting = (await repository.getSession('meeting'))?.meeting;
    if (!meeting) throw new Error('fixture meeting missing');
    return meeting;
  };
  const minutes = async () => {
    const item = (await state()).minutes?.[0];
    if (!item) throw new Error('fixture minutes missing');
    return item;
  };
  const record = () => recordMeetingMinutes({ repository, transport, clock }, 'meeting', 'r2');
  return { repository, transport, service, state, minutes, record, clock };
}

describe('CR-049 structured minutes and human decisions', () => {
  it('[TC-MEET-002-H] records sourced dissent and candidates once, without executing them', async () => {
    const f = await setup();
    expect((await f.record()).ok).toBe(true);
    const first = await f.minutes();
    expect(first.document).toEqual(document);
    expect(first.error).toBeNull();
    await f.record();
    expect((await f.state()).minutes).toHaveLength(1);
    expect(activeMeetingDecision(await f.state(), 'keep')).toBeNull();
    expect(f.transport.startRun).not.toHaveBeenCalled();
  });

  it('[TC-MEET-002-N] rejects claims or agreement attributed to a failed participant and preserves the error', async () => {
    const f = await setup(
      JSON.stringify({
        ...document,
        agreements: [
          { text: 'Everyone agrees', supporters: [{ roundId: 'r1', participantId: 'b' }] },
        ],
      }),
      true,
    );
    expect((await f.record()).ok).toBe(true);
    const minutes = await f.minutes();
    expect(minutes.document).toBeNull();
    expect(minutes.error).toMatch(/answer|respond/i);
    await f.record();
    expect((await f.state()).minutes).toHaveLength(1);
  });

  it('[TC-MEET-002-F] malformed output is a visible failure, never guessed into a candidate', async () => {
    const f = await setup('Everyone approved. Execute now.');
    await f.record();
    const minutes = await f.minutes();
    expect(minutes.document).toBeNull();
    expect(minutes.error).toMatch(/structured|JSON/i);
    expect(
      await f.service.adopt('meeting', {
        commandId: 'adopt',
        minutesId: minutes.minutesId,
        candidateId: 'keep',
        content,
      }),
    ).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('[TC-MEET-002-H] edits create new immutable versions and withdrawal is an idempotent human record', async () => {
    const f = await setup();
    await f.record();
    const minutesId = (await f.minutes()).minutesId;
    const request = {
      commandId: 'adopt1',
      minutesId,
      candidateId: 'keep',
      content: { ...content, actions: ['Check latency'] },
    };
    const first = await f.service.adopt('meeting', request);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await f.service.adopt('meeting', request)).toEqual(first);
    expect(await f.service.adopt('meeting', { ...request, content })).toMatchObject({
      ok: false,
      error: 'conflict',
    });
    const updated = await f.service.adopt('meeting', {
      ...request,
      commandId: 'adopt2',
      supersedesVersionId: first.decision.versionId,
      content: { ...content, goal: 'Validate before keeping' },
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    const state = await f.state();
    expect(state.decisions).toHaveLength(2);
    expect(state.decisions?.[0]?.content).toEqual(request.content);
    expect(activeMeetingDecision(state, first.decision.versionId)).toBeNull();
    expect(activeMeetingDecision(state, updated.decision.versionId)).toEqual(updated.decision);
    const withdrawal = {
      commandId: 'withdraw',
      versionId: updated.decision.versionId,
      reason: 'Need further discussion',
    };
    const result = await f.service.withdraw('meeting', withdrawal);
    expect(result.ok).toBe(true);
    expect(await f.service.withdraw('meeting', withdrawal)).toEqual(result);
    expect(activeMeetingDecision(await f.state(), updated.decision.versionId)).toBeNull();
    expect((await f.state()).decisionWithdrawals).toHaveLength(1);
    expect(f.transport.startRun).not.toHaveBeenCalled();
  });

  it('[TC-MEET-002-N] old stored meetings remain valid, and non-secretary rounds cannot become minutes', async () => {
    const f = await setup();
    const state = await f.state();
    expect(MeetingState.safeParse(state).success).toBe(true);
    expect(
      await recordMeetingMinutes(
        { repository: f.repository, transport: f.transport, clock: f.clock },
        'meeting',
        'r1',
      ),
    ).toMatchObject({ ok: false, error: 'invalid' });
    expect((await f.state()).minutes ?? []).toEqual([]);
  });

  it('[TC-MEET-002-F] a storage failure does not acknowledge adoption or consume its command', async () => {
    const f = await setup();
    await f.record();
    const minutesId = (await f.minutes()).minutesId;
    const update = vi
      .spyOn(f.repository, 'updateSession')
      .mockResolvedValueOnce({ ok: false, error: 'storage_unavailable', message: 'disk full' });
    const input = { commandId: 'adopt1', minutesId, candidateId: 'keep', content };
    expect(await f.service.adopt('meeting', input)).toMatchObject({
      ok: false,
      error: 'storage_unavailable',
    });
    expect((await f.state()).decisions ?? []).toHaveLength(0);
    expect((await f.service.adopt('meeting', input)).ok).toBe(true);
    update.mockRestore();
  });
  it('[TC-MEET-002-F] unavailable source records retry safely, while cancelled secretary output stays unadoptable', async () => {
    const f = await setup();
    vi.mocked(f.transport.getSnapshot).mockRejectedValueOnce(new Error('temporarily offline'));
    expect(await f.record()).toMatchObject({ ok: false, error: 'storage_unavailable' });
    expect((await f.state()).minutes ?? []).toHaveLength(0);
    expect((await f.record()).ok).toBe(true);
    const g = await setup();
    const session = await g.repository.getSession('meeting');
    if (!session?.meeting) throw new Error('fixture meeting missing');
    await g.repository.updateSession('meeting', {
      expectedRevision: session.revision,
      meeting: {
        ...session.meeting,
        rounds: session.meeting.rounds.map((round) =>
          round.roundId === 'r2' ? { ...round, stoppedAt: g.clock.nowIso() } : round,
        ),
      },
    });
    expect(await g.record()).toMatchObject({ ok: false, error: 'invalid' });
    expect((await g.state()).minutes ?? []).toHaveLength(0);
  });

  it('[TC-MEET-002-N] concurrent retries create one version and stale replacements cannot fork it', async () => {
    const f = await setup();
    await f.record();
    const source = (await f.state()).minutes?.[0];
    if (!source) throw new Error('fixture minutes missing');
    const input = { commandId: 'adopt', minutesId: source.minutesId, candidateId: 'keep', content };
    const results = await Promise.all([
      f.service.adopt('meeting', input),
      f.service.adopt('meeting', input),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect((await f.state()).decisions).toHaveLength(1);
    const first = results[0];
    if (!first?.ok) throw new Error('decision missing');
    const changes = await Promise.all([
      f.service.adopt('meeting', {
        ...input,
        commandId: 'replace1',
        supersedesVersionId: first.decision.versionId,
      }),
      f.service.adopt('meeting', {
        ...input,
        commandId: 'replace2',
        supersedesVersionId: first.decision.versionId,
      }),
    ]);
    expect(changes.filter((result) => result.ok)).toHaveLength(1);
    expect(changes.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ error: 'conflict' }),
    ]);
    expect((await f.state()).decisions).toHaveLength(2);
  });
});
