import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorralDefinition, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import {
  InProcessTransport,
  parseWorkspaceConfig,
  usageTotals,
  waitForProjection,
} from '@corral/core';
import { createLiveModels, startCorralServer } from '@corral/server';
import { linearCorral } from '@corral/testkit';
import { expect, it } from 'vitest';
import { ROOT } from '../../tools/release/candidate.ts';

// Manual provider run. Credentials stay in the application's store. The temporary workspace
// contains a synthetic writing task and explicitly selected model profiles only.
const mode = process.env.CORRAL_OUTRIDER_LIVE;
const review = mode === 'review';
const observe = mode === 'observation';
it.skipIf(mode !== '1' && !review && !observe)(
  observe
    ? 'a live shared observer reviews a scheduled writer and records the delivery of its advice'
    : review
      ? 'a live writer requests a review of V1 and submits its own V2'
      : 'two actual workers consult the same Outrider and the writer submits the result',
  async () => {
    const workerId = process.env.CORRAL_WORKER_PROFILE ?? 'deepseek-hive';
    const advisorId = process.env.CORRAL_ADVISOR_PROFILE ?? 'zai-org-glm-5.3-flash';
    const configPath = process.env.CORRAL_LIVE_CONFIG ?? join(ROOT, '.corral/config.json');
    const parsed = parseWorkspaceConfig(JSON.parse(readFileSync(configPath, 'utf8')));
    if (!parsed.ok) throw new Error('Invalid model configuration');
    const profiles = [workerId, advisorId].map((id) => {
      const profile = parsed.config.modelProfiles?.find((row) => row.id === id);
      if (!profile) throw new Error(`Missing live profile: ${id}`);
      return profile;
    });
    const directory = mkdtempSync(join(tmpdir(), 'corral-shared-consultation-'));
    mkdirSync(join(directory, '.corral'));
    writeFileSync(
      join(directory, '.corral/config.json'),
      JSON.stringify({
        schemaVersion: '0.1',
        modelProfiles: [...new Set(profiles)],
        modelProviders: parsed.config.modelProviders?.filter((row) =>
          profiles.some((profile) => profile.provider === row.id),
        ),
      }),
    );
    let server: Awaited<ReturnType<typeof startCorralServer>> | undefined;
    let runId: string | null = null;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (!server || !runId) return;
      if (!TERMINAL_RUN_STATUSES.has(server.coordinator.getSnapshot(runId).projection.status))
        server.coordinator.submit({
          schemaVersion: '0.1',
          commandId: `stop_${randomUUID()}`,
          runId,
          type: 'cancel',
          payload: { scope: { kind: 'run' }, reason: 'Manual provider check closed' },
        });
    };
    try {
      server = await startCorralServer({
        workspace: directory,
        port: 0,
        live: createLiveModels(),
        agents: {
          start: async () => {
            throw new Error('A live check cannot use the mock adapter');
          },
        },
        worktreeRoot: join(directory, 'worktrees'),
        bootstrapToken: randomUUID(),
      });
      let definition = observe
        ? linearCorral(['writer'], 'live_observation')
        : linearCorral(['planner', 'writer'], 'live_consultation');
      definition.input = {
        brief: 'Write a one-sentence invitation to a neighborhood bicycle picnic.',
        criteria: ['The invitation mentions bicycles and a picnic.'],
      };
      for (const role of definition.roles) {
        role.modelProfile = workerId;
        role.prompt = `You are the ${role.name}. First call ask on the available Outrider for one short suggestion about your own part of the invitation. After receiving the reply, write your own short result with write_artifact, then submit that version using submit_result.`;
      }
      const revisionWord = 'willow-' + randomUUID().slice(0, 8);
      if (review) {
        // A real reviewer may need time to read the supplied version and issue its reply.
        definition.limits = { ...definition.limits, questionTimeoutMs: 180000 };
        const writer = definition.roles.find((role) => role.id === 'writer_role');
        if (!writer) throw new Error('Expected a writer in the test fixture');
        writer.prompt =
          'You write the final invitation. First write your own draft using write_artifact. Then call ask on the shared Outrider using reviewArtifactVersionId set to the exact V1 artifactVersionId you just created. Ask what to improve. After receiving the review, include the exact meeting-place code from the reviewer in your invitation. Revise the same artifact using write_artifact, then call submit_result with just the new V2 artifactVersionId. Never submit the review as your own work.';
      }
      definition.sharedOutrider = {
        ...(review ? { artifactReview: true as const } : {}),
        modelProfile: advisorId,
        principles: review
          ? `Call reply immediately with the open questionId. For a version review, respond "Add the meeting-place code ${revisionWord} to the invitation." The draft is already attached to the question. For a general planning question, respond "Keep the invitation concise." Use one short answer.`
          : 'Give one relevant suggestion in a single sentence. Respond to the open question using reply with its questionId.',
        targets: { kind: 'all' },
      };
      let savedRevision: number | undefined;
      if (observe) {
        definition.input = {
          brief:
            'Write a one-sentence invitation to a neighborhood bicycle picnic at Orchard Park.',
          criteria: ['The final invitation names the venue and brings together cyclists.'],
        };
        const writer = definition.roles[0];
        if (!writer) throw new Error('Missing scheduled writer');
        writer.allowedCollaborationTools.push('read_artifact');
        writer.prompt =
          'First write a provisional invitation with write_artifact, omitting the venue. Read back your draft using read_artifact. Then write a revised version of the same artifact that includes the venue and any received meeting-place detail, and submit the revised version using submit_result. No questions are needed.';
        definition.sharedOutrider = {
          modelProfile: advisorId,
          principles: `When first reviewing this writer, immediately send one concern with advise to the current observed execution: "Please include the meeting-point code ${revisionWord} to identify the picnic entrance at Orchard Park." The code is yours to supply. Once you have sent the advice, finish the review. Avoid repeating the same suggestion.`,
          targets: { kind: 'selected', nodeIds: [] },
          observation: {
            targets: { kind: 'selected', nodeIds: ['writer'] },
            review: { interval: 1, maxRequestsPerReview: 8 },
          },
        };
        const login = await fetch(`${server.url}/api/v1/session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: server.url },
          body: JSON.stringify({
            token: new URL(server.bootstrapUrl).hash.slice('#bootstrap='.length),
          }),
        });
        expect(login.status).toBe(204);
        const headers = {
          'content-type': 'application/json',
          origin: server.url,
          cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
          'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
        };
        const saved = await fetch(`${server.url}/api/v1/corrals`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ definition }),
        });
        expect(saved.status).toBe(201);
        const { record: created } = await saved.json();
        const loaded = await fetch(`${server.url}/api/v1/corrals/${created.corralId}`, { headers });
        expect(loaded.status).toBe(200);
        const record = await loaded.json();
        expect(record.definition.sharedOutrider).toEqual(definition.sharedOutrider);
        savedRevision = record.definitionRevision;
        definition = CorralDefinition.parse(record.definition);
      }
      const coordinator = server.coordinator;
      const started = coordinator.startRun({
        schemaVersion: '0.1',
        commandId: `test_${randomUUID()}`,
        definition,
        mode: 'live',
      });
      if (!started.runId)
        throw new Error(
          `Could not start live consultation: ${started.receipt.error?.code ?? 'refused'}`,
        );
      runId = started.runId;
      const id = runId;
      console.log(
        JSON.stringify({ stage: 'started', run: id, models: profiles.map((p) => p.model) }),
      );
      heartbeat = setInterval(() => {
        const p = coordinator.getSnapshot(id).projection;
        console.log(
          JSON.stringify({
            stage: p.status,
            calls: Object.keys(p.modelCalls).length,
            questions: Object.values(p.questions).map((q) => q.status),
            ...(observe ? { advice: Object.keys(p.advice ?? {}).length } : {}),
          }),
        );
      }, 10000);
      deadline = setTimeout(stop, review || observe ? 390000 : 240000);
      const final = await waitForProjection(new InProcessTransport(coordinator), id, (p) =>
        TERMINAL_RUN_STATUSES.has(p.status),
      );
      const questions = Object.values(final.questions).filter((q) => q.sharedOutrider);
      const senders = questions.map((q) => final.executions[q.senderExecutionId]?.nodeId);
      const finals =
        final.output?.artifactVersionIds.map(
          (v) => final.executions[final.artifacts[v]!.authorExecutionId]?.nodeId,
        ) ?? [];
      const calls = Object.values(final.modelCalls);
      const advice = Object.values(final.advice ?? {}).map((row) => ({
        observer: final.executions[row.observerExecutionId]?.nodeId,
        observedWorker: final.executions[row.targetExecutionId]?.nodeId,
        severity: row.severity,
        delivery: row.delivery,
        directiveStatus: row.directiveId ? final.directives[row.directiveId]?.status : null,
        includedInWorkerRequest: calls.some(
          (c) => row.directiveId && c.directiveIds.includes(row.directiveId),
        ),
      }));
      const submitted = final.output?.artifactVersionIds[0];
      const observedFinalText =
        observe && submitted
          ? await new InProcessTransport(coordinator).getArtifactText(id, submitted)
          : null;
      const report = {
        run: id,
        status: final.status,
        reason: final.statusReason,
        models: profiles.map((p) => ({ profile: p.id, provider: p.provider, model: p.model })),
        ...(observe
          ? {
              savedRevision,
              interval: definition.sharedOutrider?.observation?.review.interval,
              advice,
              observationMarkerInFinal: observedFinalText?.includes(revisionWord) ?? false,
              observedCalls: calls.map((c) => ({
                node: final.executions[c.executionId]?.nodeId,
                profile: c.profile,
                finished: c.finished,
              })),
            }
          : {}),
        questions: questions.map((q) => ({
          sender: final.executions[q.senderExecutionId]?.nodeId,
          recipient: q.targetNodeId,
          reviewedVersion: q.reviewArtifactVersionId ?? null,
          opinionReceived: Boolean(q.answer?.body.trim()),
          status: q.status,
        })),
        calls: calls.map((c) => ({ profile: c.profile, certainty: c.certainty, usage: c.usage })),
        usage: usageTotals(final),
        finals,
        finalVersions: final.output?.artifactVersionIds.map((id) => ({
          id,
          version: final.artifacts[id]?.version,
          parent: final.artifacts[id]?.parentVersionId,
        })),
      };
      const out = join(ROOT, 'test-results', 'live');
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, `shared-outrider-${id}.json`), JSON.stringify(report, null, 2));
      console.log(
        JSON.stringify({
          stage: 'finished',
          run: id,
          status: final.status,
          reason: final.statusReason,
          senders,
          finals,
          calls: calls.length,
          usage: report.usage,
        }),
      );
      expect(final.status).toBe('succeeded');
      if (observe) {
        expect(questions).toHaveLength(0);
        expect(savedRevision).toBe(1);
        expect(advice.length).toBeGreaterThan(0);
        expect(advice.every((a) => a.observedWorker === 'writer')).toBe(true);
        expect(
          calls.some(
            (c) =>
              c.profile === advisorId &&
              advice.some((a) => a.observer === final.executions[c.executionId]?.nodeId),
          ),
        ).toBe(true);
        expect(observedFinalText).toMatch(/Orchard Park/i);
      } else {
        expect(new Set(senders)).toEqual(new Set(['planner', 'writer']));
        expect(questions.every((q) => q.status === 'answered' && q.answer?.body.trim())).toBe(true);
        expect(new Set(questions.map((q) => q.targetNodeId)).size).toBe(1);
      }
      expect(finals).toEqual(['writer']);
      if (review) {
        const requests = questions.filter((q) => q.reviewArtifactVersionId);
        expect(requests).toHaveLength(1);
        const reviewed = requests[0]?.reviewArtifactVersionId;
        const submitted = final.output?.artifactVersionIds[0];
        if (!reviewed || !submitted) throw new Error('Missing review or submitted version');
        expect(requests[0]?.artifactRefs).toContain(reviewed);
        expect(final.artifacts[reviewed]?.version).toBe(1);
        expect(final.artifacts[submitted]?.version).toBe(2);
        expect(final.artifacts[submitted]?.parentVersionId).toBe(reviewed);
        const submittedText = await new InProcessTransport(coordinator).getArtifactText(
          id,
          submitted,
        );
        expect(requests[0]?.answer?.body).toContain(revisionWord);
        expect(submittedText).toContain(revisionWord);
        expect(submittedText).toMatch(/picnic/i);
      }
      expect(new Set(calls.map((c) => c.profile))).toEqual(new Set([workerId, advisorId]));
      expect(calls.every((c) => c.finished && c.certainty === 'reported')).toBe(true);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      stop();
      await server?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  review || observe ? 420000 : 270000,
);
