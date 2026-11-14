import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpSseTransport, RestCorralRepository } from '@corral/client';
import {
  CorralDefinition,
  type MeetingHandoffReceipt,
  type MeetingView,
  type ReviewRecipeRevision,
  type Schedule,
  type ScheduledOccurrence,
} from '@corral/contracts';
import {
  conversationDefinition,
  definitionHash,
  explainDefinition,
  reviewCriteriaHash,
  waitForProjection,
} from '@corral/core';
import { Gate, ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import { type CorralServer, startCorralServer } from '../src/index.ts';

// A work session's completion criteria: stored with the session under its revision, read by
// the server when it admits a request, and fixed in the run that request starts.

const MINUTES_CONTENT = {
  goal: 'Write the report',
  scope: ['Report'],
  excludedScope: ['Deployment'],
  acceptanceCriteria: ['Readable report'],
  remainingDissent: [],
  evidence: ['User selected source'],
  risks: [],
  actions: ['Write'],
  rejectedAlternatives: [],
};

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'corral-session-criteria-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let hold: Gate | null = null;
  const token = 'test-session-criteria-0123456789abcdef';
  const server: CorralServer = await startCorralServer({
    workspace: join(root, 'workspace'),
    worktreeRoot: join(root, 'copies'),
    port: 0,
    bootstrapToken: token,
    agents: new ScriptedAgentAdapter({
      turns: 1,
      collaborate: false,
      appendNotes: false,
      beforeReply: () => hold?.wait() ?? Promise.resolve(),
      reply: (_turn, input) =>
        input.role.name === 'Secretary'
          ? JSON.stringify({
              issues: ['Report scope'],
              claims: [],
              agreements: [],
              remainingDissent: [],
              unverifiedFacts: [],
              candidates: [{ candidateId: 'report', content: MINUTES_CONTENT }],
            })
          : 'Done.',
    }),
  });
  cleanup.push(() => {
    hold?.open();
    return server.close();
  });
  const login = await fetch(`${server.url}/api/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify({ token }),
  });
  const headers = {
    cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
    'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
    origin: server.url,
  };
  const call: typeof fetch = (input, init = {}) => {
    const merged = new Headers(init.headers);
    for (const [key, value] of Object.entries(headers)) merged.set(key, value);
    if (init.body) merged.set('content-type', 'application/json');
    return fetch(input, { ...init, headers: merged });
  };
  const send = async (method: string, path: string, body?: unknown) => {
    const response = await call(`${server.url}/api/v1${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const repository = new RestCorralRepository({ baseUrl: server.url, fetch: call });
  const transport = new HttpSseTransport({ baseUrl: server.url, fetch: call });
  const session = async (criteria?: string[], corralId?: string) => {
    const created = await repository.createSession({
      projectId: 'default',
      title: 'Criteria',
      ...(criteria ? { criteria } : {}),
      ...(corralId ? { corralId } : {}),
    });
    if (!created.ok) throw new Error(created.message);
    return created.session;
  };
  const ask = (
    sessionId: string,
    commandId: string,
    team?: 'none' | 'auto' | { corralId: string },
  ) =>
    transport.startAuto({
      commandId,
      sessionId,
      brief: 'Write the report.',
      choice: { modelProfile: 'model-a' },
      mode: 'mock',
      ...(team ? { team } : {}),
    });
  const settled = (runId: string | null) =>
    waitForProjection(transport, runId ?? '', (p) => p.status === 'succeeded');
  const criteriaOf = async (runId: string | null) =>
    (await transport.getRunDefinition(runId ?? ''))?.input.criteria;
  return {
    server,
    repository,
    transport,
    send,
    session,
    ask,
    settled,
    criteriaOf,
    holdAgents() {
      const gate = new Gate();
      hold = gate;
      return gate;
    },
  };
}

it('stores criteria with the session, under its revision, and refuses malformed lines', async () => {
  const s = await setup();
  const created = await s.send('POST', '/sessions', {
    projectId: 'default',
    title: 'Report',
    criteria: ['  Names its sources ', 'Tables have units'],
  });
  expect(created.status).toBe(201);
  const id = created.body.session.sessionId as string;
  expect((await s.repository.getSession(id))?.criteria).toEqual([
    'Names its sources',
    'Tables have units',
  ]);
  const plain = await s.session();
  expect((await s.repository.getSession(plain.sessionId))?.criteria).toEqual([]);

  const updated = await s.repository.updateSession(id, {
    criteria: ['One line'],
    expectedRevision: 1,
  });
  expect(updated).toMatchObject({ ok: true, session: { revision: 2, criteria: ['One line'] } });
  const stale = await s.send('PATCH', `/sessions/${id}`, {
    criteria: ['Stale'],
    expectedRevision: 1,
  });
  expect(stale.status).toBe(409);
  expect(stale.body.error.code).toBe('REVISION_CONFLICT');
  for (const criteria of [
    Array.from({ length: 21 }, (_, i) => `Line ${i}`),
    ['First', ''],
    ['x'.repeat(201)],
  ]) {
    for (const refused of [
      await s.send('PATCH', `/sessions/${id}`, { criteria, expectedRevision: 2 }),
      await s.send('POST', '/sessions', { projectId: 'default', title: 'Bad', criteria }),
    ]) {
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatchObject({
        code: 'SCHEMA_INVALID',
        message: 'Completion criteria have up to 20 lines of 1 to 200 characters.',
      });
    }
  }
  const updatedThroughClient = await s.repository.updateSession(id, {
    criteria: ['x'.repeat(201)],
    expectedRevision: 2,
  });
  expect(updatedThroughClient).toMatchObject({ ok: false, error: 'invalid' });
  expect(await s.repository.getSession(id)).toMatchObject({ revision: 2, criteria: ['One line'] });

  const meeting = {
    version: 1,
    participants: ['a', 'b'].map((participantId) => ({
      participantId,
      name: participantId,
      prompt: 'Review',
      modelProfile: 'model-a',
    })),
    secretary: { modelProfile: 'model-a' },
  };
  expect(
    (
      await s.send('POST', '/sessions', {
        projectId: 'default',
        title: 'Meet',
        meeting,
        criteria: ['Agree'],
      })
    ).status,
  ).toBe(400);
  const made = await s.send('POST', '/sessions', { projectId: 'default', title: 'Meet', meeting });
  const meetingId = made.body.session.sessionId as string;
  expect(
    (await s.send('PATCH', `/sessions/${meetingId}`, { criteria: ['Agree'], expectedRevision: 1 }))
      .status,
  ).toBe(400);
  expect(await s.repository.getSession(meetingId)).toMatchObject({ revision: 1, criteria: [] });
});

it.each([
  ['none', 'none'],
  ['auto', 'auto'],
  ['a saved Corral', 'saved'],
  ['the chooser', undefined],
] as const)('a request with %s runs with the session criteria', async (_name, mode) => {
  const s = await setup();
  const saved = await s.repository.save({
    definition: CorralDefinition.parse(researchTeam),
    expectedDefinitionRevision: null,
  });
  if (!saved.ok) throw new Error(saved.message);
  const team = mode === 'saved' ? { corralId: saved.record.corralId } : mode;
  const session = await s.session(
    ['Names its sources', 'Fits on one page'],
    mode === 'saved' ? saved.record.corralId : undefined,
  );
  const started = await s.ask(session.sessionId, 'cmd_with_criteria', team);
  expect(started.receipt.status).toBe('applied');
  await s.settled(started.runId);
  expect(await s.criteriaOf(started.runId)).toEqual(['Names its sources', 'Fits on one page']);
  expect(saved.record.definition.input.criteria).not.toEqual([
    'Names its sources',
    'Fits on one page',
  ]);
});

it('a session without criteria starts the same definition as before', async () => {
  const s = await setup();
  const session = await s.session();
  const started = await s.ask(session.sessionId, 'cmd_plain', 'none');
  await s.settled(started.runId);
  const expected = conversationDefinition({
    id: `conversation_${session.sessionId.replace(/^session_/, '')}`,
    brief: 'Write the report.',
    choice: { modelProfile: 'model-a' },
    fileTools: false,
    workspace: { mode: 'none', reason: 'unlinked' },
  });
  const recorded = await s.transport.getRunDefinition(started.runId ?? '');
  expect(recorded && definitionHash(recorded)).toBe(definitionHash(expected));
  expect(recorded?.input.criteria).toEqual(expected.input.criteria);
});

it('changing the criteria leaves started runs alone and applies to the next request', async () => {
  const s = await setup();
  const session = await s.session(['Old line']);
  const gate = s.holdAgents();
  const first = await s.ask(session.sessionId, 'cmd_first', 'none');
  expect(first.receipt.status).toBe('applied');
  const changed = await s.repository.updateSession(session.sessionId, {
    criteria: ['New line'],
    expectedRevision: session.revision,
  });
  expect(changed.ok).toBe(true);
  expect(s.server.coordinator.getRunSnapshot(first.runId ?? '')?.definition.input.criteria).toEqual(
    ['Old line'],
  );
  gate.open();
  await s.settled(first.runId);
  const second = await s.ask(session.sessionId, 'cmd_second', 'none');
  await s.settled(second.runId);
  expect(await s.criteriaOf(second.runId)).toEqual(['New line']);
  expect(await s.criteriaOf(first.runId)).toEqual(['Old line']);
});

it('a resend of the same command after the criteria changed returns the first start', async () => {
  const s = await setup();
  const session = await s.session(['First line']);
  const first = await s.ask(session.sessionId, 'cmd_resend', 'auto');
  await s.settled(first.runId);
  const changed = await s.repository.updateSession(session.sessionId, {
    criteria: ['Changed line'],
    expectedRevision: session.revision,
  });
  expect(changed.ok).toBe(true);
  const runs = (await s.transport.listRuns()).length;
  const again = await s.send('POST', '/runs/auto', {
    schemaVersion: '0.1',
    commandId: 'cmd_resend',
    sessionId: session.sessionId,
    brief: 'Write the report.',
    choice: { modelProfile: 'model-a' },
    mode: 'mock',
    team: 'auto',
  });
  expect(again.status).toBe(200);
  expect(again.body).toMatchObject({ runId: first.runId, receipt: first.receipt });
  expect(await s.transport.listRuns()).toHaveLength(runs);
  expect(await s.criteriaOf(first.runId)).toEqual(['First line']);
});

it('a request never carries criteria itself', async () => {
  const s = await setup();
  const session = await s.session();
  const sent = await s.send('POST', '/runs/auto', {
    schemaVersion: '0.1',
    commandId: 'cmd_client_criteria',
    sessionId: session.sessionId,
    brief: 'Write the report.',
    choice: { modelProfile: 'model-a' },
    mode: 'mock',
    team: 'none',
    criteria: ['From the client'],
  });
  expect(sent.status).toBe(400);
  expect(await s.transport.listRuns()).toHaveLength(0);
});

it('a team whose review recipe pins other criteria keeps the session criteria', async () => {
  const s = await setup();
  const definition = CorralDefinition.parse(researchTeam);
  const loop = definition.nodes.find((node) => node.type === 'loop');
  if (!loop) throw new Error('missing loop');
  const recipe: ReviewRecipeRevision = {
    recipeId: 'quality',
    revision: 1,
    criteriaHash: reviewCriteriaHash(definition.input.criteria),
    candidateNodeId: 'write',
    evaluatorRoleId: 'reviewer',
    checkIds: [],
    criteriaFiles: [],
    maxAttempts: 3,
    maxRepairs: 2,
  };
  Object.assign(loop, { reviewRecipe: recipe });
  const saved = await s.repository.save({ definition, expectedDefinitionRevision: null });
  if (!saved.ok) throw new Error(saved.message);
  const session = await s.session(['Session line'], saved.record.corralId);
  const started = await s.ask(session.sessionId, 'cmd_recipe', {
    corralId: saved.record.corralId,
  });
  if (started.runId) await s.settled(started.runId);
  expect((await s.repository.getSession(session.sessionId))?.criteria).toEqual(['Session line']);
});

it('a meeting handoff keeps its adopted criteria; an explain question ignores the session criteria', async () => {
  const s = await setup();
  const target = await s.session(['Session line']);
  const created = await s.send('POST', '/sessions', {
    projectId: 'default',
    title: 'Meeting',
    meeting: {
      version: 1,
      participants: ['a', 'b'].map((participantId) => ({
        participantId,
        name: participantId,
        prompt: 'Review',
        modelProfile: 'model-a',
      })),
      secretary: { modelProfile: 'model-a' },
    },
  });
  const path = `/sessions/${created.body.session.sessionId}/meeting`;
  expect(
    (
      await s.send('POST', `${path}/rounds`, {
        kind: 'message',
        commandId: 'summary_1',
        mode: 'mock',
        text: '@비서 Summarise',
      })
    ).status,
  ).toBe(200);
  let view!: MeetingView;
  await vi.waitFor(
    async () => {
      view = (await s.send('GET', path)).body as MeetingView;
      expect(view.minutes?.[0]?.document?.candidates).toHaveLength(1);
    },
    { timeout: 10_000 },
  );
  expect(
    (
      await s.send('POST', `${path}/decisions`, {
        commandId: 'adopt_1',
        minutesId: view.minutes?.[0]?.minutesId,
        candidateId: 'report',
        content: MINUTES_CONTENT,
      })
    ).status,
  ).toBe(200);
  view = (await s.send('GET', path)).body as MeetingView;
  const sent = await s.send('POST', `${path}/handoffs`, {
    commandId: 'handoff_1',
    decisionVersionId: view.decisions?.[0]?.versionId,
    target: { kind: 'existing', sessionId: target.sessionId },
    action: 'start',
    execution: { kind: 'auto', choice: { modelProfile: 'model-a' } },
    mode: 'mock',
    targetHasDraft: false,
  });
  expect(sent.status).toBe(200);
  const handoff = sent.body.handoff as MeetingHandoffReceipt;
  expect(handoff.state).toBe('started');
  await s.settled(handoff.runId);
  expect(await s.criteriaOf(handoff.runId)).toEqual(['Readable report']);
  expect((await s.repository.getSession(target.sessionId))?.criteria).toEqual(['Session line']);

  const explain = await s.transport.startExplain({
    commandId: 'cmd_explain',
    sessionId: target.sessionId,
    question: 'Why this structure?',
    modelProfile: 'model-a',
    mode: 'mock',
  });
  await s.settled(explain.runId);
  expect(await s.criteriaOf(explain.runId)).toEqual(
    explainDefinition({ id: 'explain_x', question: 'Why this structure?', modelProfile: 'model-a' })
      .input.criteria,
  );
});

it('a scheduled request in the session runs with its criteria', async () => {
  const s = await setup();
  const session = await s.session(['Scheduled line']);
  const created = await s.send('POST', '/schedules', {
    title: 'Review',
    hostId: 'local',
    projectId: 'default',
    sessionId: session.sessionId,
    timezone: 'Asia/Tokyo',
    rule: { kind: 'daily', time: '09:00' },
    enabled: false,
    request: {
      brief: 'Summarize the available information.',
      choice: { modelProfile: 'model-a' },
      mode: 'mock',
      permissionMode: 'ask',
      configRevision: 1,
    },
  });
  expect(created.status).toBeLessThan(300);
  const schedule = created.body as Schedule;
  const ran = await s.send('POST', `/schedules/${schedule.id}/run`, {
    commandId: 'manual_review',
    expectedRevision: 1,
  });
  const occurrence = (ran.body.occurrences as ScheduledOccurrence[])[0];
  expect(occurrence?.status).toBe('started');
  await s.settled(occurrence?.runId ?? null);
  expect(await s.criteriaOf(occurrence?.runId ?? null)).toEqual(['Scheduled line']);
});

it('the criteria text never reaches the server logs', async () => {
  const marker = 'criteria-marker-7f3a9c';
  const written: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      written.push(args.map(String).join(' '));
    });
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: never[]) => {
      written.push(String(chunk));
      return write(chunk as string, ...rest);
    }) as typeof stream.write);
  }
  const s = await setup();
  const session = await s.session([`Keep ${marker}`]);
  await s.repository.updateSession(session.sessionId, {
    criteria: [`Still ${marker}`],
    expectedRevision: session.revision,
  });
  await s.send('PATCH', `/sessions/${session.sessionId}`, {
    criteria: [`${marker}${'x'.repeat(200)}`],
    expectedRevision: 2,
  });
  const started = await s.ask(session.sessionId, 'cmd_logged', 'none');
  await s.settled(started.runId);
  expect(await s.criteriaOf(started.runId)).toEqual([`Still ${marker}`]);
  for (const line of written) expect(line).not.toContain(marker);
});
