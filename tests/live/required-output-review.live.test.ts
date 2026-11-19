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
import { draftFromDefinition } from '../../packages/react/src/editor/model.ts';
import { setRequiredOutputReview } from '../../packages/react/src/team-editor/commands.ts';
import { ROOT } from '../../tools/release/candidate.ts';

// Manual opt-in. This test uses paid providers only when a person is supervising.
const mode = process.env.CORRAL_REQUIRED_REVIEW_LIVE;
const revise = mode === 'revise';
it.skipIf(mode !== '1' && !revise)(
  revise
    ? 'the original writer revises V1 from the Outrider feedback and only the approved V2 is published'
    : 'the saved Output publishes the writer version that passed its mandatory Outrider review',
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
    const directory = mkdtempSync(join(tmpdir(), 'corral-required-review-'));
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
      const definition = linearCorral(['writer'], 'live_required_review');
      definition.input = {
        brief: 'Write a one-sentence invitation to a neighborhood bicycle picnic.',
        criteria: [
          'The invitation must include the words bicycle and picnic.',
          ...(revise
            ? [
                'The final invitation must include the exact meeting-point code specified in the review. A draft without the code needs revision.',
              ]
            : []),
        ],
      };
      const writer = definition.roles[0];
      if (!writer) throw Error('Expected writer fixture');
      writer.modelProfile = workerId;
      writer.prompt =
        'Write the one-sentence invitation, incorporating review feedback when present. Use write_artifact then submit_result to submit your version.';
      if (revise)
        writer.prompt =
          'Submit this first draft using write_artifact and submit_result: "Join our neighborhood bicycle picnic on Saturday." On a revision round, incorporate the exact meeting-point code provided in the review and submit the new invitation.';
      const meetingPoint = 'Willow-' + randomUUID().slice(0, 8);
      definition.sharedOutrider = {
        modelProfile: advisorId,
        principles: revise
          ? `Check the words bicycle and picnic and the meeting-point code ${meetingPoint}. If the code is missing, request a revision and tell the writer to include exactly ${meetingPoint}. Pass when the revised invitation includes all three.`
          : 'Check that the invitation explicitly mentions both bicycle and picnic.',
        targets: { kind: 'all' },
      };
      const enabled = setRequiredOutputReview(
        draftFromDefinition(definition),
        'output',
        'final',
        'writer',
        true,
      );
      if (!enabled.ok) throw Error(enabled.reason);
      const required = enabled.draft.definition.nodes.find((n) => n.type === 'output')
        ?.requiredReviews?.[0];
      if (!required) throw Error('Review gate missing');
      const login = await fetch(server.url + '/api/v1/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: server.url },
        body: JSON.stringify({
          token: new URL(server.bootstrapUrl).hash.replace('#bootstrap=', ''),
        }),
      });
      expect(login.status).toBe(204);
      const headers = {
        origin: server.url,
        'content-type': 'application/json',
        cookie: (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
        'x-corral-csrf': login.headers.get('x-corral-csrf') ?? '',
      };
      const saved = await fetch(server.url + '/api/v1/corrals', {
        method: 'POST',
        headers,
        body: JSON.stringify({ definition: enabled.draft.definition }),
      });
      if (!saved.ok) throw Error('Team save returned ' + saved.status);
      const { record } = (await saved.json()) as {
        record: { corralId: string; definitionRevision: number };
      };
      const revision = await fetch(
        server.url +
          '/api/v1/corrals/' +
          record.corralId +
          '/revisions/' +
          record.definitionRevision,
        { headers },
      );
      expect(revision.ok).toBe(true);
      const reloaded = CorralDefinition.parse(await revision.json());
      const coordinator = server.coordinator;
      const started = coordinator.startRun({
        schemaVersion: '0.1',
        commandId: 'required_' + randomUUID(),
        definition: reloaded,
        mode: 'live',
      });
      if (!started.runId)
        throw Error('Cannot start required review: ' + (started.receipt.error?.code ?? 'refused'));
      runId = started.runId;
      const id = runId;
      heartbeat = setInterval(() => {
        const p = coordinator.getSnapshot(id).projection;
        console.log(
          JSON.stringify({
            stage: p.status,
            calls: Object.keys(p.modelCalls).length,
            reviews: Object.keys(p.reviews).length,
          }),
        );
      }, 10000);
      deadline = setTimeout(stop, 390000);
      const codeByVersion = new Map<string, boolean>();
      const final = await waitForProjection(new InProcessTransport(coordinator), id, (p) => {
        if (revise) {
          // Superseded bodies leave the public view after termination. Record the boolean
          // while the candidate is available, without storing or logging the text.
          for (const artifact of Object.values(p.artifacts)) {
            const version = artifact.artifactVersionId;
            if (
              p.executions[artifact.authorExecutionId]?.nodeId !== 'writer' ||
              codeByVersion.has(version)
            )
              continue;
            const text = coordinator.getArtifactText(id, version);
            if (text !== null) codeByVersion.set(version, text.includes(meetingPoint));
          }
        }
        return TERMINAL_RUN_STATUSES.has(p.status);
      });
      const versions = final.output?.artifactVersionIds ?? [];
      const calls = Object.values(final.modelCalls);
      const decisions = Object.values(final.workflowBranches ?? {}).filter(
        (b) => b.nodeId === required.decisionNodeId,
      );
      const reviews = Object.values(final.reviews);
      const candidateChecks = reviews.map((review) => ({
        id: review.targetVersionId,
        hasMeetingCode: codeByVersion.get(review.targetVersionId) ?? null,
        reviewGaveCode: review.issues.some((issue) => issue.reason.includes(meetingPoint)),
      }));
      const report = {
        ...(revise ? { candidateChecks } : {}),
        run: id,
        status: final.status,
        reason: final.statusReason,
        usage: usageTotals(final),
        versions,
        decisions: decisions.map((b) => ({ port: b.selectedPort, evidence: b.evidenceRefs })),
        reviews: reviews.map((r) => ({
          id: r.reviewVersionId,
          verdict: r.verdict,
          target: r.targetVersionId,
          criteria: r.criteriaVersionId,
          validation: r.issues
            .filter((issue) => issue.criterionId === 'review_format')
            .map((issue) =>
              issue.reason.startsWith('the review names')
                ? 'wrong_target'
                : issue.reason.startsWith('the review uses criteria')
                  ? 'wrong_criteria'
                  : issue.reason.startsWith('the review is not valid review JSON')
                    ? 'invalid_review_json'
                    : 'invalid_review',
            ),
        })),
        profiles: [...new Set(calls.map((c) => c.profile))],
        versionsWithInputs: versions.map((version) => ({
          id: version,
          parent: final.artifacts[version]?.parentVersionId,
          inputs: final.artifacts[version]?.inputArtifactVersionIds,
        })),
        submissions: Object.values(final.tasks).map((task) => ({
          node: task.nodeId,
          versions: task.submittedArtifactVersionIds,
        })),
      };
      const out = join(ROOT, 'test-results', 'live');
      mkdirSync(out, { recursive: true });
      writeFileSync(
        join(out, 'required-output-review-' + id + '.json'),
        JSON.stringify(report, null, 2),
      );
      console.log(JSON.stringify(report));
      expect(final.status).toBe('succeeded');
      expect(versions).toHaveLength(1);
      const selected = versions[0]!;
      expect(final.executions[final.artifacts[selected]!.authorExecutionId]?.nodeId).toBe('writer');
      const last = decisions.at(-1);
      expect(last?.selectedPort).toBe('pass');
      expect(
        last?.evidenceRefs.some(
          (ref) =>
            ref.kind === 'review' &&
            final.reviews[ref.id]?.targetVersionId === selected &&
            final.reviews[ref.id]?.verdict === 'pass',
        ),
      ).toBe(true);
      if (revise) {
        const [first, second] = reviews;
        expect(decisions.map((b) => b.selectedPort)).toEqual(['revise', 'pass']);
        expect(first?.verdict).toBe('revise');
        expect(first?.issues.some((issue) => issue.reason.includes(meetingPoint))).toBe(true);
        expect(second?.targetVersionId).toBe(selected);
        expect(second?.verdict).toBe('pass');
        const original = first!.targetVersionId,
          feedback = first!.reviewVersionId;
        expect(final.artifacts[selected]?.parentVersionId).toBe(original);
        expect(codeByVersion.get(original)).toBe(false);
        expect(codeByVersion.get(selected)).toBe(true);
        expect(final.artifacts[selected]?.inputArtifactVersionIds).toContain(feedback);
        expect(final.executions[final.artifacts[original]!.authorExecutionId]?.nodeId).toBe(
          'writer',
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
  420000,
);
