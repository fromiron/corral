import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
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
it.skipIf(mode !== '1' && !review)(
  review
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
      const definition = linearCorral(['planner', 'writer'], 'live_consultation');
      definition.input = {
        brief: 'Write a one-sentence invitation to a neighborhood bicycle picnic.',
        criteria: ['The invitation mentions bicycles and a picnic.'],
      };
      for (const role of definition.roles) {
        role.modelProfile = workerId;
        role.prompt = `You are the ${role.name}. First call ask on the available Outrider for one short suggestion about your own part of the invitation. After receiving the reply, write your own short result with write_artifact, then submit that version using submit_result.`;
      }
      if (review) {
        const writer = definition.roles.find((role) => role.id === 'writer_role');
        if (!writer) throw new Error('Expected a writer in the test fixture');
        writer.prompt =
          'You write the final invitation. First write your own draft using write_artifact. Then call ask on the shared Outrider using reviewArtifactVersionId set to the exact V1 artifactVersionId you just created. Ask what to improve. After receiving the review, revise the same artifact using write_artifact, then call submit_result with just the new V2 artifactVersionId. Never submit the review as your own work.';
      }
      definition.sharedOutrider = {
        ...(review ? { artifactReview: true as const } : {}),
        modelProfile: advisorId,
        principles:
          'Give one relevant suggestion in a single sentence. Respond to the open question using reply with its questionId.',
        targets: { kind: 'all' },
      };
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
          }),
        );
      }, 10000);
      deadline = setTimeout(stop, 240000);
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
      const report = {
        run: id,
        status: final.status,
        reason: final.statusReason,
        models: profiles.map((p) => ({ profile: p.id, provider: p.provider, model: p.model })),
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
      expect(new Set(senders)).toEqual(new Set(['planner', 'writer']));
      expect(questions.every((q) => q.status === 'answered' && q.answer?.body.trim())).toBe(true);
      expect(new Set(questions.map((q) => q.targetNodeId)).size).toBe(1);
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
        expect(await new InProcessTransport(coordinator).getArtifactText(id, submitted)).toMatch(
          /picnic/i,
        );
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
  270000,
);
