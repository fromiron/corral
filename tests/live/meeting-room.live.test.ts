import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Identifier,
  type MeetingHandoffReceipt,
  type MeetingView,
  type Receipt,
  type RunEvent,
  TERMINAL_RUN_STATUSES,
} from '@corral/contracts';
import {
  type CorralServer,
  createLiveModels,
  type ModelProfileView,
  startCorralServer,
} from '@corral/server';
import { expect, it } from 'vitest';
import { candidateHash, ROOT } from '../../tools/release/candidate.ts';

// Explicit opt-in only: existing model sign-ins, an isolated repository, 36 requests / 10 minutes.
// CORRAL_MEETING_LIVE=1 pnpm test:live meeting-room.live.test.ts
const REQUEST_CAP = 36;
const DEADLINE_MS = 600_000;
const ORIGINAL = 'export const sum = (a, b) => a - b;\n';
const TEST = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sum } from './sum.js';
test('sum adds two numbers', () => assert.equal(sum(2, 3), 5));
`;

it.skipIf(process.env.CORRAL_MEETING_LIVE !== '1')(
  '[TC-MEET-003-H] real models discuss, adopt, execute an isolated file fix and discuss its result',
  async () => {
    const candidate = candidateHash();
    const startedAt = new Date().toISOString();
    const directory = mkdtempSync(join(tmpdir(), 'corral-meeting-live-'));
    const workspace = join(directory, 'workspace');
    const repository = join(directory, 'fixture');
    const worktreeRoot = join(directory, 'worktrees');
    const participants = (process.env.CORRAL_MEETING_PROFILES ?? 'model-a,model-b').split(',');
    expect(participants).toHaveLength(2);
    const profiles = {
      architect: Identifier.parse(participants[0]),
      builder: Identifier.parse(participants[1]),
      secretary: Identifier.parse(process.env.CORRAL_MEETING_SECRETARY ?? 'model-b'),
      work: Identifier.parse(process.env.CORRAL_MEETING_WORKER ?? 'model-b'),
    };
    const marker = `MEETING_RESULT_${randomUUID().replaceAll('-', '')}`;
    const deadline = new AbortController();
    const events = new Map<string, RunEvent[]>();
    const stops: (() => void)[] = [];
    const observations: Record<string, unknown> = {};
    let server: CorralServer | undefined;
    let phase = 'setup';
    let calls = 0;
    let routeCalls = 0;
    let passed = false;
    const setPhase = (next: string) => {
      phase = next;
      console.log(`[meeting-live] ${phase}`);
    };
    const observeRuns = () => {
      if (!server) return;
      for (const run of server.coordinator.listRuns()) {
        if (events.has(run.runId)) continue;
        const log: RunEvent[] = [];
        events.set(run.runId, log);
        stops.push(server.coordinator.subscribe(run.runId, 0, (event) => log.push(event)));
      }
    };
    const cancel = () => {
      if (!server) return;
      for (const run of server.coordinator.listRuns()) {
        if (TERMINAL_RUN_STATUSES.has(run.status)) continue;
        server.coordinator.submit({
          schemaVersion: '0.1',
          commandId: `live_stop_${randomUUID()}`,
          runId: run.runId,
          type: 'cancel',
          payload: { scope: { kind: 'run' }, reason: 'Meeting live fixture ended' },
        });
      }
    };
    const timer = setTimeout(() => {
      deadline.abort();
      cancel();
    }, DEADLINE_MS);
    const admit = () => {
      if (deadline.signal.aborted || calls >= REQUEST_CAP)
        throw new Error('Meeting live fixture request or time limit reached');
      calls += 1;
    };
    try {
      mkdirSync(join(workspace, '.corral'), { recursive: true });
      const configPath = join(ROOT, '.corral', 'config.json');
      const config = existsSync(configPath)
        ? (JSON.parse(readFileSync(configPath, 'utf8')) as {
            modelProfiles?: unknown;
            modelProviders?: unknown;
          })
        : {};
      writeFileSync(
        join(workspace, '.corral', 'config.json'),
        JSON.stringify({
          schemaVersion: '0.1',
          modelProfiles: config.modelProfiles,
          modelProviders: config.modelProviders,
        }),
        { mode: 0o600 },
      );
      mkdirSync(repository);
      writeFileSync(join(repository, 'package.json'), '{"type":"module"}\n');
      writeFileSync(join(repository, 'sum.js'), ORIGINAL);
      writeFileSync(join(repository, 'sum.test.js'), TEST);
      const nodeTest = (cwd: string) =>
        spawnSync(process.execPath, ['--test', 'sum.test.js'], {
          cwd,
          encoding: 'utf8',
          timeout: 10_000,
        });
      const red = nodeTest(repository);
      expect(red.status).toBe(1);
      observations.baselineTestFailed = true;
      for (const args of [
        ['init', '-q'],
        ['add', '.'],
        ['commit', '-q', '-m', 'Meeting live fixture'],
      ])
        execFileSync(
          'git',
          ['-c', 'user.name=Live Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
          { cwd: repository, stdio: 'pipe' },
        );

      const live = createLiveModels();
      const stream = live.models.streamSimple.bind(live.models);
      live.models.streamSimple = (...args) => {
        admit();
        routeCalls += 1;
        return stream(...args);
      };
      const agents = live.agents;
      live.agents = (...args) => {
        const real = agents(...args);
        return {
          start: (input, host) =>
            real.start(input, {
              ...host,
              prepareModelRequest: (...request) => {
                admit();
                return host.prepareModelRequest(...request);
              },
            }),
        };
      };
      server = await startCorralServer({
        workspace,
        worktreeRoot,
        port: 0,
        live,
        bootstrapToken: randomUUID(),
        agents: {
          start: async () => {
            throw new Error('Unexpected simulated execution');
          },
        },
      });
      const running = server;
      const login = await fetch(`${server.url}/api/v1/session`, {
        method: 'POST',
        signal: deadline.signal,
        headers: { 'content-type': 'application/json', origin: server.url },
        body: JSON.stringify({
          token: new URL(server.bootstrapUrl).hash.replace('#bootstrap=', ''),
        }),
      });
      expect(login.status).toBe(204);
      const headers = {
        'content-type': 'application/json',
        origin: server.url,
        cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
        'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
      };
      const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        const response = await fetch(`${running.url}/api/v1${path}`, {
          method,
          headers,
          signal: deadline.signal,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} during ${phase}`);
        return response.json() as Promise<T>;
      };
      const poll = async <T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> => {
        while (true) {
          deadline.signal.throwIfAborted();
          const value = await read();
          observeRuns();
          if (ready(value)) return value;
          await delay(500, undefined, { signal: deadline.signal });
        }
      };
      setPhase('connected profiles');
      const available = await api<ModelProfileView[]>('GET', '/model-profiles');
      observations.profiles = Object.entries(profiles).map(([role, profileId]) => {
        const profile = available.find((item) => item.profileId === profileId);
        expect(profile?.available).toBe(true);
        return {
          role,
          profileId,
          modelId: profile?.modelId,
          provider: profile?.provider,
          method: profile?.method,
        };
      });
      await api('PUT', '/projects/default/workspace', { path: repository });
      await api('PATCH', '/projects/default/workspace', { trusted: true });
      const target = await api<{ session: { sessionId: string } }>('POST', '/sessions', {
        projectId: 'default',
        title: 'Meeting live work',
      });
      const targetId = target.session.sessionId;
      const copy = await api<{ worktree: { bindingId: string } }>(
        'POST',
        `/sessions/${targetId}/worktree`,
        {},
      );
      const copyDirectory = join(worktreeRoot, copy.worktree.bindingId, targetId);
      const created = await api<{ session: { sessionId: string } }>('POST', '/sessions', {
        projectId: 'default',
        title: 'Meeting live verification',
        meeting: {
          version: 1,
          participants: [
            {
              participantId: 'architect',
              name: 'Architect',
              prompt: 'Review correctness and scope. Keep each reply below 100 words.',
              modelProfile: profiles.architect,
            },
            {
              participantId: 'builder',
              name: 'Builder',
              prompt:
                'Review the smallest implementation and tests. Keep each reply below 100 words.',
              modelProfile: profiles.builder,
            },
          ],
          secretary: {
            modelProfile: profiles.secretary,
            prompt:
              'Keep minutes concise and propose exactly one actionable candidate matching the supplied task.',
          },
        },
      });
      const sourceId = created.session.sessionId;
      const path = `/sessions/${sourceId}/meeting`;
      const meeting = () => api<MeetingView>('GET', path);
      const finishRound = (index: number) =>
        poll(meeting, (view) => {
          const round = view.rounds[index];
          if (!round || round.active) return false;
          expect(
            round.answers.every((answer) => answer.status === 'answered' && Boolean(answer.text)),
          ).toBe(true);
          return true;
        });
      const send = (text: string) =>
        api('POST', `${path}/rounds`, {
          kind: 'message',
          commandId: `meeting_live_${randomUUID()}`,
          mode: 'live',
          text,
        });
      const task = [
        'Discuss this small, fully specified code fix; no research or clarification is needed.',
        'The isolated ESM project has sum.js containing: export const sum = (a, b) => a - b;',
        'sum.test.js uses node:test and asserts sum(2, 3) === 5; this test currently fails.',
        'Propose replacing subtraction with addition in sum.js only. Keep tests and package.json unchanged, add no dependencies.',
        'The worker must read the real files, edit sum.js, read back the change, write a brief final artifact, then submit_result.',
        'The worker has file tools; the person runs the Node test after the worker finishes. Do not claim the worker ran it.',
        `The final work artifact must include the exact result identifier ${marker}.`,
        'Choose the single-agent execution template: this one-line fix needs no delegation.',
      ].join('\n');
      setPhase('real participant discussion');
      await send(task);
      let view = await finishRound(0);
      expect(view.rounds[0]?.answers).toHaveLength(2);
      expect(view.decisions ?? []).toHaveLength(0);
      expect(readFileSync(join(copyDirectory, 'sum.js'), 'utf8')).toBe(ORIGINAL);
      setPhase('real secretary minutes');
      await send(
        '@secretary Summarise the discussion and propose the single code-fix candidate, preserving all supplied constraints and the exact result identifier.',
      );
      await finishRound(1);
      view = await poll(meeting, (value) => Boolean(value.minutes?.length));
      const minutes = view.minutes?.[0];
      expect(minutes?.error).toBeNull();
      const proposed = minutes?.document?.candidates[0];
      expect(proposed).toBeDefined();
      if (!minutes || !proposed)
        throw new Error('The secretary did not supply a decision candidate');
      expect(JSON.stringify(proposed.content)).toContain('sum.js');
      expect(JSON.stringify(proposed.content)).toContain(marker);
      expect(readFileSync(join(copyDirectory, 'sum.js'), 'utf8')).toBe(ORIGINAL);
      observations.meetingDidNotWriteFiles = true;
      observations.secretaryCandidate = true;

      setPhase('human decision adoption');
      await api('POST', `${path}/decisions`, {
        commandId: `adopt_${randomUUID()}`,
        minutesId: minutes.minutesId,
        candidateId: proposed.candidateId,
        content: proposed.content,
      });
      view = await meeting();
      const decision = view.decisions?.[0];
      expect(decision?.content).toEqual(proposed.content);
      expect(decision?.versionId).toBeTruthy();

      setPhase('handoff and real work execution');
      const handoffRequest = {
        commandId: `handoff_${randomUUID()}`,
        decisionVersionId: decision?.versionId,
        target: { kind: 'existing', sessionId: targetId },
        action: 'start',
        execution: {
          kind: 'auto',
          choice: { modelProfile: profiles.work, reasoning: { mode: 'fixed', level: 'low' } },
        },
        mode: 'live',
        targetHasDraft: false,
      };
      const started = await api<{ handoff: MeetingHandoffReceipt }>(
        'POST',
        `${path}/handoffs`,
        handoffRequest,
      );
      expect(started.handoff.state).toBe('started');
      const runId = started.handoff.runId;
      if (!runId) throw new Error('Handoff did not start a run');
      observeRuns();
      const receiptPath = `${path}/handoffs/${handoffRequest.commandId}`;
      let progressConfirmations = 0;
      const finished = await poll(
        async () => {
          const result = await api<{ handoff: MeetingHandoffReceipt }>('GET', receiptPath);
          const projection = running.coordinator.getSnapshot(runId).projection;
          if (projection.status === 'awaiting_user') {
            const pending = Object.values(projection.approvals).filter(
              (item) => item.status === 'pending',
            );
            const limit = events.get(runId)?.findLast((event) => event.type === 'limit.reached');
            expect(progressConfirmations).toBeLessThan(2);
            // The second confirmation requires the promised edit, not another read/plan loop.
            if (progressConfirmations === 1) {
              expect(readFileSync(join(copyDirectory, 'sum.js'), 'utf8')).toBe(
                ORIGINAL.replace('a - b', 'a + b'),
              );
              expect(readFileSync(join(copyDirectory, 'sum.test.js'), 'utf8')).toBe(TEST);
              expect(readFileSync(join(copyDirectory, 'package.json'), 'utf8')).toBe(
                '{"type":"module"}\n',
              );
              expect(nodeTest(copyDirectory).status).toBe(0);
            }
            expect(pending).toHaveLength(1);
            expect(pending[0]?.kind).toBe('user_action');
            expect(pending[0]?.tool).toBeUndefined();
            expect(limit?.payload.limitKind).toBe('no_progress');
            const approval = pending[0]!;
            const receipt = await api<Receipt>('POST', `/runs/${runId}/commands`, {
              schemaVersion: '0.1',
              commandId: `continue_${randomUUID()}`,
              runId,
              expectedControlRevision: projection.controlRevision,
              type: 'resolve_approval',
              payload: {
                approvalId: approval.approvalId,
                decision: 'approve',
                subjectVersionId: approval.subjectVersionIds[0],
              },
            });
            expect(receipt.status).toBe('applied');
            progressConfirmations += 1;
            observations.noProgressConfirmations = progressConfirmations;
            console.log(
              `[meeting-live] confirmed no-progress intervention ${progressConfirmations}`,
            );
          }
          return result;
        },
        (value) => {
          const status = running.coordinator.getSnapshot(runId).projection.status;
          return Boolean(value.handoff.result && TERMINAL_RUN_STATUSES.has(status));
        },
      );
      expect(finished.handoff.result?.status).toBe('succeeded');
      expect(finished.handoff.autoRoute?.source).toBe('model');
      const output = finished.handoff.result?.artifactVersionId;
      expect(output).toBeTruthy();
      expect(server.coordinator.getArtifactText(runId, output ?? '')).toContain(marker);
      const file = await api<{ content: { kind: string; text?: string } }>(
        'GET',
        `/sessions/${targetId}/worktree/file?path=sum.js`,
      );
      expect(file.content.kind).toBe('text');
      expect(file.content.text).toBe(ORIGINAL.replace('a - b', 'a + b'));
      expect(file.content.text).toBe(readFileSync(join(copyDirectory, 'sum.js'), 'utf8'));
      expect(readFileSync(join(copyDirectory, 'sum.test.js'), 'utf8')).toBe(TEST);
      expect(readFileSync(join(repository, 'sum.js'), 'utf8')).toBe(ORIGINAL);
      const green = nodeTest(copyDirectory);
      expect(green.status).toBe(0);
      observations.work = {
        status: finished.handoff.result?.status,
        route: finished.handoff.autoRoute?.template,
        targetFileChanged: true,
        originalUnchanged: true,
        unchangedNodeTestPassed: true,
        testExecutor: 'host',
      };
      const callsBeforeReplay = calls;
      const replay = await api<{ handoff: MeetingHandoffReceipt }>(
        'POST',
        `${path}/handoffs`,
        handoffRequest,
      );
      expect(replay.handoff.runId).toBe(runId);
      expect(calls).toBe(callsBeforeReplay);
      observations.handoffReplayStartedNoWork = true;

      setPhase('real result rediscussion');
      await api('POST', `${receiptPath}/rediscuss`, {
        commandId: `rediscuss_${randomUUID()}`,
        mode: 'live',
      });
      view = await finishRound(2);
      expect(view.rounds[2]?.answers).toHaveLength(2);
      expect(view.rounds[2]?.message).toContain(marker);
      expect(view.rounds[2]?.message).toContain(runId);
      expect(view.rounds[2]?.message).toContain(output);
      observations.resultRediscussed = true;
      observations.rounds = view.rounds.map((round) => ({
        kind: round.kind,
        answers: round.answers.map((answer) => ({
          participantId: answer.participantId,
          status: answer.status,
          usage: answer.usage,
        })),
      }));
      expect(calls).toBeLessThanOrEqual(REQUEST_CAP);
      for (const log of events.values()) {
        const finished = log.flatMap((event) =>
          event.type === 'model.finished' ? [event.payload] : [],
        );
        expect(finished.length).toBeGreaterThan(0);
        expect(finished.every((value) => value.certainty === 'reported')).toBe(true);
        expect(finished.some((value) => (value.normalizedUsage.outputTokens ?? 0) > 0)).toBe(true);
      }
      setPhase('candidate identity');
      expect(candidateHash()).toBe(candidate);
      passed = true;
    } catch {
      // Raw provider errors and assertion values can expose inputs or local paths.
      throw new Error(
        `Meeting live regression failed at ${phase}; inspect test-results/live/meeting-room.json.`,
      );
    } finally {
      clearTimeout(timer);
      observeRuns();
      observations.runs = (server?.coordinator.listRuns() ?? []).map((run) => {
        const log = events.get(run.runId) ?? [];
        const snapshot = server?.coordinator.getRunSnapshot(run.runId);
        return {
          runId: run.runId,
          roles: snapshot?.definition.roles.map((role) => role.name),
          models: Object.values(snapshot?.models ?? {}).map((model) => ({
            profile: model.profile,
            provider: model.provider,
            modelId: model.modelId,
            auth: model.auth,
          })),
          status: run.status,
          modelRequests: log.filter((event) => event.type === 'model.request_prepared').length,
          tools: log.flatMap((event) =>
            event.type === 'tool.requested' ? [event.payload.name] : [],
          ),
          usage: log.flatMap((event) =>
            event.type === 'model.finished'
              ? [{ ...event.payload.normalizedUsage, certainty: event.payload.certainty }]
              : [],
          ),
        };
      });
      deadline.abort();
      cancel();
      for (const stop of stops) stop();
      await server?.close();
      if (process.env.CORRAL_MEETING_KEEP_FIXTURE !== '1')
        rmSync(directory, { recursive: true, force: true });
      const results = join(ROOT, 'test-results', 'live');
      mkdirSync(results, { recursive: true });
      writeFileSync(
        join(results, 'meeting-room.json'),
        `${JSON.stringify(
          {
            candidateHash: candidate,
            sameCandidate: candidateHash() === candidate,
            startedAt,
            completedAt: new Date().toISOString(),
            passed,
            phase,
            logicalRequests: calls,
            routeRequests: routeCalls,
            limits: {
              logicalRequests: REQUEST_CAP,
              timeoutMs: DEADLINE_MS,
              providerOutputTokenCapGuaranteed: false,
            },
            ...observations,
          },
          null,
          2,
        )}\n`,
      );
    }
  },
  DEADLINE_MS + 60_000,
);
