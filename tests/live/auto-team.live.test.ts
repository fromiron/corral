import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AutoRoute,
  Identifier,
  ReasoningLevel,
  type RunEvent,
  TERMINAL_RUN_STATUSES,
} from '@corral/contracts';
import {
  AUTO_ROUTE_TIMEOUT_MS,
  type AutoStartResult,
  InProcessTransport,
  openRunArchive,
  waitForProjection,
} from '@corral/core';
import {
  type CorralServer,
  createLiveModels,
  type ModelProfileView,
  startCorralServer,
} from '@corral/server';
import { describe, expect, it } from 'vitest';
import { candidateHash, ROOT } from '../../tools/release/candidate.ts';

// Separate opt-in from the older provider smoke: this runs the actual server and child
// workers, and accepts only a real reviewer verdict. Nothing in ordinary CI calls a model.
// CORRAL_AUTO_LIVE=1 pnpm test:live auto-team.live.test.ts
const enabled = process.env.CORRAL_AUTO_LIVE === '1';
const REQUEST_CAP = 36;
const ATTEMPT_TIMEOUT_MS = 360_000;

describe.skipIf(!enabled)('auto team live regression (CR-024)', () => {
  it('writes, reviews and reopens private history with reported usage', async () => {
    const candidate = candidateHash();
    const startedAt = new Date().toISOString();
    const profile = Identifier.parse(process.env.CORRAL_AUTO_PROFILE ?? 'model-b');
    const level = ReasoningLevel.parse(process.env.CORRAL_AUTO_REASONING ?? 'low');
    const marker = `AUTO_REQUIREMENT_${randomUUID().replaceAll('-', '')}`;
    const directory = mkdtempSync(join(tmpdir(), 'corral-auto-live-'));
    let server: CorralServer | undefined;
    let runId: string | null = null;
    let calls = 0;
    let routeCalls = 0;
    let stage = 'setup';
    let passed = false;
    let stopEvents = () => {};
    const events: RunEvent[] = [];
    const reviewerInputs: boolean[] = [];
    const reviewerRequests: boolean[] = [];
    const observations: Record<string, unknown> = {};
    const deadline = new AbortController();
    const diagnostics = () => {
      if (!server || !runId) return { runStarted: false, phase: stage };
      const projection = server.coordinator.getSnapshot(runId).projection;
      const now = Date.now();
      const prepared = events.filter((event) => event.type === 'model.request_prepared');
      const finished = events.filter((event) => event.type === 'model.finished');
      const payloads = events.filter((event) => event.type === 'model.payload_recorded');
      return {
        runStarted: true,
        phase: stage,
        status: projection.status,
        statusReason: projection.statusReason,
        elapsedMs: now - Date.parse(startedAt),
        outputApprovalRequired: server.coordinator
          .getRunSnapshot(runId)
          ?.definition.nodes.some((node) => node.type === 'output' && node.requireApproval),
        preparedRequests: prepared.length,
        finishedRequests: finished.length,
        providerPayloads: payloads.length,
        executions: Object.values(projection.executions).map((execution) => ({
          node: execution.nodeId,
          status: execution.status,
          activity: execution.activity,
          waitingKind: execution.waitingOn?.kind ?? null,
          round: execution.iterationId
            ? (projection.iterations[execution.iterationId]?.no ?? null)
            : null,
          hasError: execution.error !== null,
        })),
        approvals: Object.values(projection.approvals).map(({ kind, status }) => ({
          kind,
          status,
        })),
        iterations: Object.values(projection.iterations).map(({ no, outcome }) => ({
          no,
          outcome,
        })),
        reviews: Object.values(projection.reviews).map(({ verdict, stale, issues }) => ({
          verdict,
          stale,
          requiredIssues: issues.filter((issue) => issue.severity === 'required').length,
          advisoryIssues: issues.filter((issue) => issue.severity === 'advisory').length,
          invalidFormat: issues.some((issue) => issue.criterionId === 'review_format'),
        })),
        requests: prepared.map((event) => {
          const done = finished.find(
            (value) => value.payload.modelCallId === event.payload.modelCallId,
          );
          return {
            node: projection.executions[event.payload.executionId]?.nodeId ?? null,
            preparedAt: event.recordedAt,
            finishedAt: done?.recordedAt ?? null,
            durationMs: (done ? Date.parse(done.recordedAt) : now) - Date.parse(event.recordedAt),
            finished: done !== undefined,
            reasoning: event.payload.reasoning?.resolved ?? null,
            usage: done?.payload.normalizedUsage ?? null,
            certainty: done?.payload.certainty ?? null,
          };
        }),
      };
    };
    const cancelRun = () => {
      if (!server || !runId) return;
      server.coordinator.submit({
        schemaVersion: '0.1',
        commandId: `cmd_stop_${randomUUID()}`,
        runId,
        type: 'cancel',
        payload: { scope: { kind: 'run' }, reason: 'auto live test ended' },
      });
    };
    const timer = setTimeout(() => {
      observations.beforeDeadlineCancellation = diagnostics();
      deadline.abort();
      cancelRun();
    }, ATTEMPT_TIMEOUT_MS);
    const admitRequest = () => {
      if (deadline.signal.aborted || calls >= REQUEST_CAP)
        throw new Error('auto live request or time limit reached');
      calls += 1;
    };
    try {
      const live = createLiveModels();
      const stream = live.models.streamSimple.bind(live.models);
      live.models.streamSimple = (model, context, options) => {
        admitRequest();
        routeCalls += 1;
        return stream(model, context, options);
      };
      const realAgents = live.agents;
      live.agents = (...args) => {
        const real = realAgents(...args);
        return {
          start(input, host) {
            if (input.role.id === 'reviewer')
              reviewerInputs.push(
                input.inputs.some((value) => value.name === 'brief' && value.text.includes(marker)),
              );
            return real.start(input, {
              ...host,
              prepareModelRequest(record, reasoningInput) {
                admitRequest();
                if (input.role.id === 'reviewer')
                  reviewerRequests.push(reasoningInput?.request.includes(marker) ?? false);
                return host.prepareModelRequest(record, reasoningInput);
              },
            });
          },
        };
      };
      mkdirSync(join(directory, '.corral'));
      writeFileSync(
        join(directory, '.corral', 'config.json'),
        JSON.stringify({ schemaVersion: '0.1' }),
      );
      server = await startCorralServer({
        workspace: directory,
        port: 0,
        live,
        // A live request must never use a simulated adapter, even after an error.
        agents: {
          start: async () => {
            throw new Error('unexpected simulated execution');
          },
        },
        worktreeRoot: join(directory, 'worktrees'),
        bootstrapToken: randomUUID(),
      });
      const token = new URL(server.bootstrapUrl).hash.replace('#bootstrap=', '');
      const login = await fetch(`${server.url}/api/v1/session`, {
        method: 'POST',
        signal: deadline.signal,
        headers: { 'content-type': 'application/json', origin: server.url },
        body: JSON.stringify({ token }),
      });
      expect(login.status).toBe(204);
      const headers = {
        'content-type': 'application/json',
        origin: server.url,
        cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
        'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
      };
      const api = (path: string, body?: unknown) =>
        fetch(`${server?.url}/api/v1${path}`, {
          headers,
          signal: deadline.signal,
          ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        });
      stage = 'OAuth profile preflight';
      const profileResponse = await api('/model-profiles');
      expect(profileResponse.status).toBe(200);
      const profiles: ModelProfileView[] = await profileResponse.json();
      const selected = profiles.find((value) => value.profileId === profile);
      expect(selected?.available).toBe(true);
      expect(selected?.method).toBe('oauth');
      expect(selected?.reasoningCapabilities.levels.includes(level)).toBe(true);
      observations.model = selected?.modelId;
      observations.provider = selected?.provider;
      const created = await api('/sessions', { projectId: 'default', title: 'Auto live check' });
      expect(created.status).toBe(201);
      const session: { session: { sessionId: string } } = await created.json();
      const sessionId = Identifier.parse(session.session.sessionId);

      stage = 'automatic reviewed run';
      const autoRequestStartedAt = Date.now();
      const response = await api('/runs/auto', {
        schemaVersion: '0.1',
        commandId: `cmd_auto_live_${randomUUID()}`,
        sessionId,
        mode: 'live',
        choice: { modelProfile: profile, reasoning: { mode: 'fixed', level } },
        brief: [
          'Write a tiny release note using a separate planner, writer and reviewer: choose write_review.',
          'This is a synthetic document needing a careful review, not outside research.',
          'Source facts supplied by this request: Fictional Tool 0.1 adds saved drafts and fixes a spelling mistake.',
          `The final note must contain the exact identifier ${marker}.`,
          'Use two short paragraphs, fewer than 90 words, and name the supplied brief as the source.',
          'Keep planning and review concise. Complete your own assigned step with write_artifact then submit_result.',
          'The reviewer must judge the real draft against these requirements and revise it if needed.',
        ].join('\n'),
      });
      expect(response.status).toBe(201);
      const started: AutoStartResult = await response.json();
      runId = Identifier.parse(started.runId);
      observations.autoResponseDurationMs = Date.now() - autoRequestStartedAt;
      stopEvents = server.coordinator.subscribe(runId, 0, (event) => events.push(event));
      const route = AutoRoute.parse(started.autoRoute);
      observations.route = {
        template: route.template,
        source: route.source,
        usage: route.usage,
        fallback: route.fallback ?? null,
      };
      expect(route.template).toBe('write_review');
      expect(route.source).toBe('model');
      expect(route.usage?.inputTokens).toBeGreaterThan(0);
      expect(route.usage?.outputTokens).toBeGreaterThan(0);
      const final = await waitForProjection(
        new InProcessTransport(server.coordinator),
        runId,
        (p) => TERMINAL_RUN_STATUSES.has(p.status) || p.status === 'awaiting_user',
      );
      observations.status = final.status;
      stage = 'reviewed success and original request delivery';
      expect(final.status).toBe('succeeded');
      expect(events.some((e) => e.type === 'review.recorded' && e.payload.verdict === 'pass')).toBe(
        true,
      );
      expect(reviewerInputs.length).toBeGreaterThan(0);
      expect(reviewerInputs.every(Boolean)).toBe(true);
      expect(reviewerRequests.length).toBeGreaterThan(0);
      expect(reviewerRequests.every(Boolean)).toBe(true);
      const outputId = final.output?.artifactVersionIds[0];
      expect(outputId).toBeDefined();
      expect(server.coordinator.getArtifactText(runId, outputId ?? '')?.includes(marker)).toBe(
        true,
      );

      stage = 'reported usage and reasoning wire';
      const finished = events.flatMap((e) => (e.type === 'model.finished' ? [e.payload] : []));
      const prepared = events.flatMap((e) =>
        e.type === 'model.request_prepared' ? [e.payload] : [],
      );
      const payloads = events.flatMap((e) =>
        e.type === 'model.payload_recorded' ? [e.payload] : [],
      );
      expect(routeCalls).toBe(1);
      expect(calls).toBeLessThanOrEqual(REQUEST_CAP);
      expect(finished.length).toBeGreaterThanOrEqual(3);
      expect(finished.every((value) => value.certainty === 'reported')).toBe(true);
      expect(finished.every((value) => value.normalizedUsage.outputTokens !== null)).toBe(true);
      expect(prepared.every((value) => value.reasoning?.resolved === level)).toBe(true);
      expect(payloads.length).toBe(prepared.length);
      expect(
        payloads.every(
          (value) => value.reasoning?.kind === 'effort' && value.reasoning.value === level,
        ),
      ).toBe(true);
      const snapshot = server.coordinator.getRunSnapshot(runId);
      expect(
        snapshot?.definition.roles.every(
          (role) =>
            role.modelProfile === profile &&
            role.reasoning?.mode === 'fixed' &&
            role.reasoning.level === level,
        ),
      ).toBe(true);
      observations.roleUsage = finished.map((value) => ({
        ...value.normalizedUsage,
        certainty: value.certainty,
      }));
      observations.rolePayloads = payloads.length;

      stage = 'private history export and reopen';
      const exportedResponse = await api(`/runs/${runId}/export`, { privateTranscript: true });
      expect(exportedResponse.status).toBe(200);
      const exported: unknown = await exportedResponse.json();
      const opened = openRunArchive(exported);
      expect(opened.visibility).toBe('private');
      if (opened.visibility !== 'private') throw new Error('private archive expected');
      expect(opened.projection.status).toBe('succeeded');
      expect(opened.snapshot.autoRoute?.template).toBe('write_review');
      expect(opened.artifacts[outputId ?? '']?.includes(marker)).toBe(true);
      const reopenedResponse = await api('/history/import', exported);
      expect(reopenedResponse.status).toBe(200);
      const reopened: { projection: { status: string } } = await reopenedResponse.json();
      expect(reopened.projection.status).toBe('succeeded');
      observations.privateHistoryReopened = true;
      stage = 'candidate identity';
      expect(candidateHash()).toBe(candidate);
      passed = true;
    } catch {
      // Provider exceptions and assertion values can include request bodies or local paths.
      throw new Error(`Auto live regression failed at ${stage}; inspect the metadata-only result.`);
    } finally {
      clearTimeout(timer);
      observations.finalSnapshot = diagnostics();
      deadline.abort();
      cancelRun();
      stopEvents();
      await server?.close();
      rmSync(directory, { recursive: true, force: true });
      const resultDirectory = join(ROOT, 'test-results', 'live');
      mkdirSync(resultDirectory, { recursive: true });
      writeFileSync(
        join(resultDirectory, 'auto-team.json'),
        `${JSON.stringify(
          {
            candidateHash: candidate,
            startedAt,
            completedAt: new Date().toISOString(),
            passed,
            stage,
            profile,
            reasoning: level,
            logicalRequests: calls,
            routeRequests: routeCalls,
            reviewerOriginalInput: reviewerInputs.length > 0 && reviewerInputs.every(Boolean),
            reviewerModelContext: reviewerRequests.length > 0 && reviewerRequests.every(Boolean),
            limits: {
              logicalRequests: REQUEST_CAP,
              attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
              routeTimeoutMs: AUTO_ROUTE_TIMEOUT_MS,
              routeObservableOutputBytes: 256,
              oauthProviderOutputTokenCapGuaranteed: false,
              unobservedReasoningGenerationCapGuaranteed: false,
            },
            ...observations,
          },
          null,
          2,
        )}\n`,
      );
    }
  }, 420_000);
});
