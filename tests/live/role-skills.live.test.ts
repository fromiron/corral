import { createHash, randomUUID } from 'node:crypto';
import {
  type CorralDefinition,
  canonicalJson,
  type HarnessResourceView,
  type ModelAttemptPage,
  type PackageReview,
  type RoleHarnessPreview,
  type RoleSkillRef,
  TERMINAL_RUN_STATUSES,
} from '@corral/contracts';
import { InProcessTransport, waitForProjection } from '@corral/core';
import { createLiveModels, type LiveModels } from '@corral/server';
import { linearCorral } from '@corral/testkit';
import { getCurrentSystemPrompt } from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import {
  type LiveProfileServer,
  withLiveProfile,
  writeLiveResults,
} from './fixtures/profile-server.ts';

const selectedName = 'picnic-invitation';
const otherName = 'index-format';

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`Live server returned ${response.status}`);
  return response.json();
}

async function installSkill(
  api: LiveProfileServer['api'],
  name: string,
  description: string,
  body: string,
) {
  const review = await json<PackageReview>(
    await api('/harness/documents/review', {
      kind: 'skill',
      name,
      content: `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body}`,
    }),
  );
  const installed = await json<HarnessResourceView>(
    await api('/harness/resources', { reviewId: review.reviewId }),
  );
  expect(installed.hash).toBe(review.resource.hash);
  expect(installed.trustedAt).toBeNull();
  const trusted = await json<HarnessResourceView>(
    await api(`/harness/resources/${installed.hash}/trust`, { trusted: true }, 'PUT'),
  );
  expect(trusted.hash).toBe(installed.hash);
  expect(trusted.trustedAt !== null).toBe(true);
  expect(trusted.skills.length).toBe(1);
  const [entry] = trusted.skills;
  if (!entry) throw new Error('No skill in trusted document');
  expect(entry.name).toBe(name);
  return { resourceHash: trusted.hash, entry: entry.entry } satisfies RoleSkillRef;
}

// Body delivery and listing are different facts. Observe only the advertised names on the real
// provider path, preserving its original hooks. Join our booleans to the worker's payload hash.
function catalog(text: string) {
  const listing = /<available_skills>([\s\S]*?)<\/available_skills>/.exec(text)?.[1] ?? '';
  return {
    selected: listing.includes(`<name>${selectedName}</name>`),
    other: listing.includes(`<name>${otherName}</name>`),
  };
}
interface Listing {
  selected: boolean;
  other: boolean;
}
function observeListings(live: LiveModels) {
  const byPayload = new Map<string, { context: Listing; wire: Listing }>();
  const stream = live.models.streamSimple.bind(live.models);
  live.models.streamSimple = (model, context, options) => {
    const listing = catalog(getCurrentSystemPrompt(context.messages));
    return stream(model, context, {
      ...options,
      async onPayload(payload, selected) {
        const actual = (await options?.onPayload?.(payload, selected)) ?? payload;
        const serialized = canonicalJson(JSON.parse(JSON.stringify(actual)));
        byPayload.set(createHash('sha256').update(serialized).digest('hex'), {
          context: listing,
          wire: catalog(serialized),
        });
        return actual;
      },
    });
  };
  return byPayload;
}

async function saveTeam(api: LiveProfileServer['api'], definition: CorralDefinition) {
  const { record } = await json<{ record: { corralId: string; definitionRevision: number } }>(
    await api('/corrals', { definition }),
  );
  return { corralId: record.corralId, definitionRevision: record.definitionRevision };
}

it.skipIf(process.env.CORRAL_ROLE_SKILLS_LIVE !== '1')(
  'a saved writer advertises only its selected auto skill; the unbound writer stays on the legacy path',
  async () => {
    const profileId = process.env.CORRAL_WORKER_PROFILE ?? 'deepseek-hive';
    const live = createLiveModels();
    const listings = observeListings(live);
    await withLiveProfile(
      profileId,
      300_000,
      async ({ server, api }) => {
        const selected = await installSkill(
          api,
          selectedName,
          'Writing a brief picnic invitation.',
          'Name the activity and invite the reader to join.',
        );
        const other = await installSkill(
          api,
          otherName,
          'Preparing an alphabetical index.',
          'Sort entries alphabetically.',
        );
        expect(selected.resourceHash).not.toBe(other.resourceHash);
        const base = linearCorral(['writer'], 'live_writer_b');
        base.input = {
          brief: 'Write a one-sentence invitation to a neighborhood bicycle picnic.',
          criteria: ['Name the activity.'],
        };
        const [writer] = base.roles;
        if (!writer) throw new Error('Missing writer role');
        writer.modelProfile = profileId;
        writer.prompt =
          'Write a short invitation. Use write_artifact and then submit_result with that artifact version.';
        const node = base.nodes.find((n) => n.type === 'agent');
        if (node?.invocation !== 'scheduled') throw new Error('Missing scheduled writer');
        node.stepInstruction = 'Address local cyclists directly.';
        const a = { ...base, id: 'live_writer_a', roles: [{ ...writer, skills: [selected] }] };
        const teamA = await saveTeam(api, a);
        const teamB = await saveTeam(api, base);
        expect(teamA.corralId).not.toBe(teamB.corralId);
        const alternative = await json<RoleHarnessPreview>(
          await api('/harness/preview', {
            projectId: 'default',
            roleId: writer.id,
            skills: [other],
          }),
        );
        const alternativeSnapshot = alternative.snapshot;
        if (!alternativeSnapshot) throw new Error('Other skill could not be resolved');
        expect(
          alternativeSnapshot.resources.map((r) => ({ resourceHash: r.hash, entry: r.entry })),
        ).toEqual([other]);
        const coordinator = server.coordinator;
        const transport = new InProcessTransport(coordinator);
        const results = [];
        for (const [teamId, revision] of [
          ['A', teamA],
          ['B', teamB],
        ] as const) {
          const start = performance.now();
          const started = coordinator.startRun({
            schemaVersion: '0.1',
            commandId: `role_skills_${randomUUID()}`,
            mode: 'live',
            ...revision,
          });
          if (!started.runId)
            throw new Error(`Run ${teamId} refused: ${started.receipt.error?.code ?? 'unknown'}`);
          const runId = started.runId;
          const snapshot = coordinator.getRunSnapshot(runId);
          if (!snapshot) throw new Error('Missing run snapshot');
          const harness = snapshot.harnesses?.[writer.id];
          const reads = new Set<string>();
          const bodies = new Set<string>();
          const payloads: string[] = [];
          let unexpectedSkill = false;
          let stepSections = 0;
          const stop = transport.subscribe(runId, 0, {
            onEvent(event) {
              if (event.type === 'skill.read') {
                const { resourceHash, skillName, bodyHash } = event.payload;
                unexpectedSkill ||=
                  resourceHash !== selected.resourceHash || skillName !== selectedName;
                reads.add(bodyHash);
              }
              if (
                event.type === 'model.request_recorded' &&
                event.payload.sections.some((s) => s.name === 'corral_step_instruction')
              )
                stepSections++;
              if (event.type !== 'model.payload_recorded') return;
              payloads.push(event.payload.payloadHash);
              for (const skill of event.payload.skills ?? []) {
                unexpectedSkill ||=
                  skill.resourceHash !== selected.resourceHash || skill.name !== selectedName;
                bodies.add(skill.bodyHash);
              }
            },
          });
          try {
            const final = await waitForProjection(transport, runId, (p) =>
              TERMINAL_RUN_STATUSES.has(p.status),
            );
            const latencyMs = Math.round(performance.now() - start);
            const attempts = await json<ModelAttemptPage>(
              await api(`/model-attempts?runId=${runId}`),
            );
            const submitters = (final.output?.artifactVersionIds ?? []).map((id) => {
              const artifact = final.artifacts[id];
              return artifact && final.executions[artifact.authorExecutionId]?.nodeId;
            });
            // Inspect the first provider call: its catalog cannot be confused with a read result.
            const first = listings.get(payloads[0] ?? '');
            const report = {
              team: teamId,
              profileId,
              latencyMs,
              status: final.status,
              requests: attempts.items.length,
              failures: attempts.items.flatMap((a) =>
                a.failure ? [{ code: a.failure.code, status: a.failure.status }] : [],
              ),
              submitters,
              harness: harness?.binding.profileId ?? null,
              resources: harness?.resources.length ?? 0,
              selectedEntryPinned:
                harness?.resources.some(
                  (r) => r.hash === selected.resourceHash && r.entry === selected.entry,
                ) ?? false,
              otherEntryPinned:
                harness?.resources.some(
                  (r) => r.hash === other.resourceHash && r.entry === other.entry,
                ) ?? false,
              otherResolutionDiffers: harness
                ? alternativeSnapshot.snapshotHash !== harness.snapshotHash
                : null,
              contextListing: first?.context ?? null,
              payloadListing: first?.wire ?? null,
              payloadRecords: payloads.length,
              stepSections,
              read: reads.size > 0,
              bodySent: bodies.size > 0,
            };
            results.push(report);
            writeLiveResults(process.env.CORRAL_ROLE_SKILLS_OUT, results);
            console.log(JSON.stringify(report));
            expect(report.status).toBe('succeeded');
            expect(report.submitters).toEqual(['writer']);
            expect(attempts.nextCursor).toBeNull();
            expect(report.requests).toBeGreaterThan(0);
            expect(report.stepSections).toBeGreaterThan(0);
            expect(report.contextListing).toEqual({ selected: teamId === 'A', other: false });
            expect(report.payloadListing).toEqual({ selected: teamId === 'A', other: false });
            expect(unexpectedSkill).toBe(false);
            expect(reads).toEqual(bodies);
            if (teamId === 'A') {
              expect(harness?.binding).toEqual({ profileId: 'role-skills-minimal', revision: 1 });
              expect(harness?.policy).toBe('strict');
              expect(
                harness?.resources.map((r) => ({
                  resourceHash: r.hash,
                  entry: r.entry,
                  kind: r.kind,
                  mode: r.skillMode,
                })),
              ).toEqual([{ ...selected, kind: 'skill', mode: 'auto' }]);
              expect(report.otherResolutionDiffers).toBe(true);
            } else {
              expect(
                snapshot.definition.roles.find((role) => role.id === writer.id)?.skills,
              ).toBeUndefined();
              expect(harness).toBeUndefined();
              expect(report.read).toBe(false);
            }
          } finally {
            stop();
          }
        }
      },
      live,
    );
  },
  330_000,
);
