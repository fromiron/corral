import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Identifier,
  type MeetingParticipant,
  type MeetingView,
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

// Manual opt-in only; reuses existing sign-ins, with 28 logical requests / 10 minutes.
// CORRAL_MEETING_CHAT_LIVE=1 pnpm test:live meeting-chat.live.test.ts
const INTERACTIONS_ONLY = process.env.CORRAL_MEETING_CHAT_INTERACTIONS_ONLY === '1';
const REQUEST_CAP = INTERACTIONS_ONLY ? 10 : 28;
const REPORT = INTERACTIONS_ONLY ? 'meeting-chat-interactions.json' : 'meeting-chat.json';
const DEADLINE_MS = 600_000;

it.skipIf(process.env.CORRAL_MEETING_CHAT_LIVE !== '1')(
  'real models hold a chat, continue it, and plan only when asked',
  async () => {
    const candidate = candidateHash();
    const startedAt = new Date().toISOString();
    const directory = mkdtempSync(join(tmpdir(), 'corral-meeting-chat-live-'));
    const workspace = join(directory, 'workspace');
    const profileIds = (process.env.CORRAL_MEETING_CHAT_PROFILES ?? 'model-a,model-b,deepseek-hive')
      .split(',')
      .map((value) => Identifier.parse(value));
    expect(profileIds).toHaveLength(3);
    const secretaryProfile = Identifier.parse(process.env.CORRAL_MEETING_SECRETARY ?? 'model-b');
    const deadline = new AbortController();
    const events = new Map<string, RunEvent[]>();
    const stops: (() => void)[] = [];
    const conversations: Record<string, MeetingView> = {};
    const observations: Record<string, unknown> = { conversations };
    let server: CorralServer | undefined;
    let calls = 0;
    let phase = 'setup';
    let passed = false;
    const setPhase = (next: string) => {
      phase = next;
      console.log(`[meeting-chat-live] ${phase}`);
    };
    const observeRuns = () => {
      for (const run of server?.coordinator.listRuns() ?? []) {
        if (events.has(run.runId)) continue;
        const log: RunEvent[] = [];
        events.set(run.runId, log);
        stops.push(server!.coordinator.subscribe(run.runId, 0, (event) => log.push(event)));
      }
    };
    const cancel = () => {
      for (const run of server?.coordinator.listRuns() ?? []) {
        if (TERMINAL_RUN_STATUSES.has(run.status)) continue;
        server!.coordinator.submit({
          schemaVersion: '0.1',
          commandId: `chat_live_stop_${randomUUID()}`,
          runId: run.runId,
          type: 'cancel',
          payload: { scope: { kind: 'run' }, reason: 'Meeting chat live fixture ended' },
        });
      }
    };
    const timer = setTimeout(() => {
      deadline.abort();
      cancel();
    }, DEADLINE_MS);
    const admit = () => {
      if (deadline.signal.aborted || calls >= REQUEST_CAP)
        throw new Error('Meeting chat live fixture request or time limit reached');
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
      const live = createLiveModels();
      const stream = live.models.streamSimple.bind(live.models);
      live.models.streamSimple = (...args) => {
        admit();
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
        worktreeRoot: join(directory, 'worktrees'),
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
      const login = await fetch(`${running.url}/api/v1/session`, {
        method: 'POST',
        signal: deadline.signal,
        headers: { 'content-type': 'application/json', origin: running.url },
        body: JSON.stringify({
          token: new URL(running.bootstrapUrl).hash.replace('#bootstrap=', ''),
        }),
      });
      expect(login.status).toBe(204);
      const headers = {
        'content-type': 'application/json',
        origin: running.url,
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
      setPhase('connected profiles');
      const available = await api<ModelProfileView[]>('GET', '/model-profiles');
      observations.profiles = [...new Set([...profileIds, secretaryProfile])].map((profileId) => {
        const profile = available.find((item) => item.profileId === profileId);
        expect(profile?.available).toBe(true);
        return {
          profileId,
          modelId: profile?.modelId,
          provider: profile?.provider,
          method: profile?.method,
        };
      });
      const participants: MeetingParticipant[] = profileIds.map((profileId, index) => ({
        participantId: `model_${index + 1}`,
        name: available.find((item) => item.profileId === profileId)!.modelId,
        prompt: '',
        modelProfile: profileId,
      }));
      const createMeeting = async (title: string, members: MeetingParticipant[]) => {
        const result = await api<{ session: { sessionId: string } }>('POST', '/sessions', {
          projectId: 'default',
          title,
          meeting: {
            version: 1,
            participants: members,
            secretary: { modelProfile: secretaryProfile },
          },
        });
        return `/sessions/${result.session.sessionId}/meeting`;
      };
      const read = async (path: string) => {
        const value = await api<MeetingView>('GET', path);
        conversations[path] = value;
        observeRuns();
        return value;
      };
      const send = (path: string, text: string, mentions?: string[]) =>
        api('POST', `${path}/rounds`, {
          kind: 'message',
          commandId: `chat_live_${randomUUID()}`,
          mode: 'live',
          text,
          ...(mentions ? { mentions } : {}),
        });
      const finished = async (path: string, index: number, expectedIds: string[]) => {
        while (true) {
          deadline.signal.throwIfAborted();
          const view = await read(path);
          const message = view.rounds.filter((item) => item.message !== null)[index];
          expect(
            view.rounds
              .flatMap((item) => item.answers)
              .filter((answer) => answer.status === 'running').length,
          ).toBeLessThanOrEqual(1);
          if (message && view.rounds.every((item) => !item.active)) {
            const replies = view.rounds
              .slice(view.rounds.indexOf(message))
              .flatMap((item) => item.answers)
              .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            for (const id of expectedIds)
              expect(replies.some((answer) => answer.participantId === id)).toBe(true);
            for (const [index, answer] of replies.entries()) {
              const input = running.coordinator.getRunSnapshot(answer.runId!)!.definition.input
                .brief;
              for (const earlier of replies.slice(0, index)) expect(input).toContain(earlier.text);
              for (const other of view.config.participants.filter(
                (participant) =>
                  participant.participantId !== answer.participantId && participant.prompt,
              ))
                expect(input.split('Conversation so far:')[0]).not.toContain(other.prompt);
              expect(answer.status).toBe('answered');
              expect(answer.text?.trim().length).toBeGreaterThan(0);
            }
            return view;
          }
          await delay(500, undefined, { signal: deadline.signal });
        }
      };
      const checkConversation = (view: MeetingView) => {
        expect(view.minutes ?? []).toHaveLength(0);
        expect(view.decisions ?? []).toHaveLength(0);
        for (const message of view.rounds) {
          for (const answer of message.answers) {
            expect(answer.text!.length).toBeLessThanOrEqual(2200);
            expect(answer.text).not.toMatch(
              /(?:아키텍트|아키텍처|구현|검증)\s*(?:역할|관점|계획|단계)|(?:^|\n)\s*#{1,6}\s*(?:구현|검증|설계)/u,
            );
            const brief = running.coordinator.getRunSnapshot(answer.runId!)!.definition.input.brief;
            for (const previous of view.rounds.slice(0, view.rounds.indexOf(message))) {
              if (previous.message && (previous.order ?? 0) < (answer.order ?? 0))
                expect(brief).toContain(previous.message);
              for (const priorAnswer of previous.answers)
                if ((priorAnswer.order ?? 0) < (answer.order ?? 0))
                  expect(brief).toContain(priorAnswer.text);
            }
          }
        }
      };

      if (INTERACTIONS_ONLY) {
        const members = participants.map((participant, index) => ({
          ...participant,
          name: ['루나', '솔', '하이브'][index]!,
        }));
        const room = await createMeeting('Live interjections and agent mentions', members);
        setPhase('agent mention calls another real model');
        const request = {
          kind: 'message',
          commandId: `mention_live_${randomUUID()}`,
          mode: 'live',
          text: '@루나 오늘 저녁으로 김치찌개와 비빔밥 중 하나를 골라 줘. 그리고 솔을 멘션해서 어느 쪽이 좋은지 물어봐. 솔은 자신의 의견을 한두 문장으로 답하고 추가 질문이나 멘션 없이 마쳐 줘.',
        };
        const accepted = await api<{ roundId: string }>('POST', `${room}/rounds`, request);
        let view = await finished(room, 0, ['model_1', 'model_2']);
        expect(view.rounds[0]!.answers[0]!.text).toContain('@솔');
        expect(
          view.rounds.some(
            (round) =>
              round.replyTo?.participantId === 'model_1' &&
              round.answers.some((answer) => answer.participantId === 'model_2'),
          ),
        ).toBe(true);
        expect(calls).toBe(2);
        const beforeReplay = calls;
        expect(await api('POST', `${room}/rounds`, request)).toMatchObject({
          ok: true,
          outcome: 'started',
          roundId: accepted.roundId,
        });
        await read(room);
        expect(calls).toBe(beforeReplay);
        observations.agentMentionResponded = true;
        observations.replayStartedNoWork = true;

        setPhase('human messages post during a real answer');
        await send(
          room,
          '하이브, 저녁 메뉴 세 가지와 그 이유를 설명해 줘. 다른 사람을 멘션하지는 마.',
          ['model_3'],
        );
        view = await read(room);
        const original = view.rounds.at(-1)!;
        expect(original.answers.some((answer) => answer.status === 'running')).toBe(true);
        await send(room, '추가 조건이 있어. 매운 음식은 빼 줘.');
        await send(
          room,
          '솔, 그리고 10분 안에 준비할 수 있으면 좋겠어. 방금 두 조건을 반영해 하나만 제안하고 다른 사람은 멘션하지 마.',
          ['model_2'],
        );
        view = await read(room);
        expect(view.rounds.filter((round) => round.message !== null)).toHaveLength(4);
        expect(view.queued).toBeNull();
        expect(
          view.rounds
            .find((round) => round.roundId === original.roundId)!
            .answers.some((answer) => answer.status === 'running'),
        ).toBe(true);
        view = await finished(room, 3, ['model_2']);
        const latest = view.rounds.filter((round) => round.message !== null).at(-1)!;
        const latestAnswer = latest.answers[0]!;
        const input = running.coordinator.getRunSnapshot(latestAnswer.runId!)!.definition.input
          .brief;
        expect(input).toContain('매운 음식은 빼 줘');
        expect(input).toContain('10분 안에');
        expect(input).toContain(
          view.rounds.find((round) => round.roundId === original.roundId)!.answers[0]!.text,
        );
        expect(calls).toBe(4);
        expect(view.minutes).toEqual([]);
        expect(view.decisions).toEqual([]);
        observations.humanInterjectionsPostedImmediately = true;
        observations.latestHumanContextVerified = true;
        observations.reopenStartedNoWork = true;
        const beforeReopen = calls;
        await read(room);
        expect(calls).toBe(beforeReopen);
      } else {
        setPhase('ordinary conversation');
        const casual = await createMeeting('Live everyday chat', participants);
        const all = participants.map((participant) => participant.participantId);
        await send(casual, '니들 배고프냐');
        let view = await finished(casual, 0, all);
        checkConversation(view);
        await send(casual, '그럼 오늘 저녁 뭐 먹는 게 좋다고 생각해?');
        view = await finished(casual, 1, all);
        checkConversation(view);
        setPhase('one participant follow-up');
        await send(casual, '왜 그 메뉴를 추천했어?', [all[0]!]);
        view = await finished(casual, 2, [all[0]!]);
        checkConversation(view);
        setPhase('conversation preference change');
        await send(casual, '오늘은 무거운 국물 요리 말고 가볍게 먹고 싶어. 그럼 뭘 먹을까?');
        view = await finished(casual, 3, all);
        checkConversation(view);
        observations.casualHistoryPreserved = true;

        setPhase('existing development roles in everyday chat');
        // Existing saved meetings retain these pre-chat template roles.
        const rolePrompts = [
          ['아키텍트', '구조, 경계, 장기 유지보수 관점에서 판단합니다.'],
          ['구현', '실제로 만드는 방법, 난이도, 일정과 위험을 따집니다.'],
          ['검증', '실패 사례와 반례, 확인해야 할 검사를 찾습니다.'],
        ];
        const development = await createMeeting(
          'Live development discussion',
          participants.map((participant, index) => ({
            ...participant,
            name: rolePrompts[index]![0]!,
            prompt: rolePrompts[index]![1]!,
          })),
        );
        await send(development, '오늘 저녁 뭐 먹는 게 좋다고 생각해?');
        view = await finished(development, 0, all);
        checkConversation(view);
        observations.existingRolesDidNotForceReport = true;
        setPhase('explicit development discussion');
        await send(
          development,
          '개인용 할 일 앱을 만들려고 해. 이번에는 로그인이나 서버 없이 브라우저에서 할 일을 추가하고 완료 표시만 할 수 있으면 돼. 어떤 식으로 만들면 좋을까?',
        );
        view = await finished(development, 1, all);
        expect(view.minutes ?? []).toHaveLength(0);
        expect(view.decisions ?? []).toHaveLength(0);
        observations.noAutomaticMinutes = true;
        setPhase('requested secretary plan');
        await send(
          development,
          '@비서 로그인과 서버 없이 할 일 추가와 완료 표시부터 만들자. 지금 의견을 회의록으로 정리하고, 구현 프로젝트로 넘길 수 있게 범위와 완료 기준, 다음 작업을 담은 플랜을 만들어줘.',
        );
        view = await finished(development, 2, ['secretary']);
        expect(view.minutes).toHaveLength(1);
        expect(view.minutes?.[0]?.error).toBeNull();
        const plans = view.minutes?.[0]?.document?.candidates ?? [];
        expect(plans.length).toBeGreaterThan(0);
        expect(plans.some((plan) => plan.content.scope.length > 0)).toBe(true);
        expect(plans.some((plan) => plan.content.acceptanceCriteria.length > 0)).toBe(true);
        expect(plans.some((plan) => plan.content.actions.length > 0)).toBe(true);
        expect(view.decisions ?? []).toHaveLength(0);
        observations.requestedPlanCreated = true;

        const beforeReopen = calls;
        await read(casual);
        await read(development);
        expect(calls).toBe(beforeReopen);
        observations.reopenStartedNoWork = true;
        expect(running.coordinator.listRuns().length).toBeGreaterThanOrEqual(17);
      }
      observations.sequentialContextVerified = true;
      for (const run of running.coordinator.listRuns()) {
        expect(run.status).toBe('succeeded');
        const log = events.get(run.runId) ?? [];
        const completed = log.flatMap((event) =>
          event.type === 'model.finished' ? [event.payload] : [],
        );
        expect(completed.length).toBeGreaterThan(0);
        expect(completed.every((value) => value.certainty === 'reported')).toBe(true);
        expect(completed.some((value) => (value.normalizedUsage.outputTokens ?? 0) > 0)).toBe(true);
        const definition = running.coordinator.getRunSnapshot(run.runId)!.definition;
        expect(definition.roles[0]?.allowedWorkTools).toEqual(['write_artifact']);
        expect(definition.roles[0]?.allowedCollaborationTools).toEqual(['submit_result']);
      }
      expect(calls).toBeLessThanOrEqual(REQUEST_CAP);
      setPhase('candidate identity');
      expect(candidateHash()).toBe(candidate);
      passed = true;
    } catch (error) {
      observations.failure = String(error);
      // Actual answers stay in a private ignored report for semantic review, never stdout.
      throw new Error(
        `Meeting chat live regression failed at ${phase}; inspect test-results/live/${REPORT}.`,
      );
    } finally {
      clearTimeout(timer);
      observeRuns();
      observations.runs = (server?.coordinator.listRuns() ?? []).map((run) => ({
        runId: run.runId,
        status: run.status,
        modelRequests: (events.get(run.runId) ?? []).filter(
          (event) => event.type === 'model.request_prepared',
        ).length,
        usage: (events.get(run.runId) ?? []).flatMap((event) =>
          event.type === 'model.finished'
            ? [{ ...event.payload.normalizedUsage, certainty: event.payload.certainty }]
            : [],
        ),
      }));
      deadline.abort();
      cancel();
      for (const stop of stops) stop();
      await server?.close();
      if (process.env.CORRAL_MEETING_KEEP_FIXTURE !== '1')
        rmSync(directory, { recursive: true, force: true });
      const results = join(ROOT, 'test-results', 'live');
      mkdirSync(results, { recursive: true });
      writeFileSync(
        join(results, REPORT),
        `${JSON.stringify(
          {
            candidateHash: candidate,
            sameCandidate: candidateHash() === candidate,
            startedAt,
            completedAt: new Date().toISOString(),
            passed,
            phase,
            logicalRequests: calls,
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
        { mode: 0o600 },
      );
    }
  },
  DEADLINE_MS + 60_000,
);
