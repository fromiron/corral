import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEvent } from '@corral/contracts';
import { InProcessTransport, parseWorkspaceConfig, waitForProjection } from '@corral/core';
import { createLiveModels, startCorralServer } from '@corral/server';
import { linearCorral } from '@corral/testkit';
import { expect, it } from 'vitest';
import { ROOT } from '../../tools/release/candidate.ts';

// Explicit opt-in only (CORRAL_TOOL_INTENT_LIVE=1), watched by the person or agent who starts it.
// llm-runtime.md: every Corral tool now declares an optional `i`. This settles whether real
// models still call the tools with it declared, and whether they fill it.
for (const profileId of ['deepseek-hive', 'zai-org-glm-5.3-flash'])
  it.skipIf(process.env.CORRAL_TOOL_INTENT_LIVE !== '1')(
    `${profileId}: tools declaring an intent field still run, and the intent stays out of the arguments`,
    async () => {
      const parsed = parseWorkspaceConfig(
        JSON.parse(readFileSync(join(ROOT, '.corral/config.json'), 'utf8')),
      );
      if (!parsed.ok) throw new Error('invalid workspace config');
      const profile = parsed.config.modelProfiles?.find((row) => row.id === profileId);
      if (!profile) throw new Error(`${profileId} is not configured`);
      const directory = mkdtempSync(join(tmpdir(), 'corral-tool-intent-'));
      mkdirSync(join(directory, '.corral'));
      writeFileSync(
        join(directory, '.corral/config.json'),
        JSON.stringify({
          schemaVersion: '0.1',
          modelProfiles: [profile],
          modelProviders: parsed.config.modelProviders?.filter((row) => row.id === profile.provider),
        }),
      );
      const server = await startCorralServer({
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
      const coordinator = server.coordinator;
      let runId: string | null = null;
      const stop = () => {
        if (runId)
          coordinator.submit({
            schemaVersion: '0.1',
            commandId: `stop_${randomUUID()}`,
            runId,
            type: 'cancel',
            payload: { scope: { kind: 'run' }, reason: 'tool intent live check closed' },
          });
      };
      const deadline = setTimeout(stop, 230000);
      try {
        const definition = linearCorral(['writer'], 'tool-intent-check');
        definition.input = {
          brief:
            'Write a two-line note on why short commit subjects help reviewers. Save it with write_artifact, then call submit_result with its version.',
          criteria: ['A two-line note saved and submitted.'],
        };
        definition.roles[0]!.modelProfile = profile.id;
        const started = coordinator.startRun({
          schemaVersion: '0.1',
          commandId: `intent_${randomUUID()}`,
          definition,
          mode: 'live',
        });
        if (!started.runId)
          throw new Error(`the run could not start: ${started.receipt.error?.message ?? ''}`);
        runId = started.runId;
        const id = runId;
        const transport = new InProcessTransport(coordinator);
        const events: RunEvent[] = [];
        transport.subscribe(id, 0, { onEvent: (event) => events.push(event), onFrame: () => {} });
        const final = await waitForProjection(transport, id, (p) =>
          ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(p.status),
        );
        const requested = events.filter(
          (event): event is Extract<RunEvent, { type: 'tool.requested' }> =>
            event.type === 'tool.requested',
        );
        const report = {
          profile: profileId,
          checkedAt: new Date().toISOString(),
          status: final.status,
          calls: requested.map((event) => ({
            name: event.payload.name,
            intent: event.payload.intent ?? null,
            argKeys: Object.keys(event.payload.validatedArgs),
          })),
          blocked: events
            .filter((event) => event.type === 'tool.blocked')
            .map((event) => (event.payload as { reason?: string }).reason ?? null),
        };
        mkdirSync(join(ROOT, 'test-results/live'), { recursive: true });
        writeFileSync(
          join(ROOT, `test-results/live/tool-intent-${profileId}.json`),
          JSON.stringify(report, null, 2),
        );
        expect(final.status).toBe('succeeded');
        expect(requested.some((event) => event.payload.name === 'write_artifact')).toBe(true);
        for (const event of requested) expect(event.payload.validatedArgs).not.toHaveProperty('i');
      } finally {
        clearTimeout(deadline);
        stop();
        await server.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
    240000,
  );
