import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PiAgentAdapter, processChannel, sdkProcessChannel } from '@corral/adapter-pi';
import { Coordinator, InMemoryRunStore, InProcessTransport, waitForProjection } from '@corral/core';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { expect, it } from 'vitest';
import { HarnessService } from '../src/harness/service.ts';

// Explicit registry opt-in; models are local fake providers, never paid calls.
it.skipIf(process.env.CORRAL_HARNESS_NETWORK !== '1')(
  '[TC-HAR-005-H] the original Ponytail package affects only the role bound to its immutable revision',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'corral-ponytail-e2e-'));
    const db = openDatabase(':memory:');
    const clock = new FakeClock();
    const harnesses = new HarnessService({ root, db, clock });
    try {
      const review = await harnesses.discoverPackage('npm:@dietrichgebert/ponytail@5.3.2');
      expect(review.resource).toMatchObject({ name: '@dietrichgebert/ponytail', version: '5.3.2' });
      const resource = harnesses.install(review.reviewId);
      harnesses.trust(resource.hash, true);
      const profile = harnesses.saveProfile('ponytail', 0, {
        name: 'Ponytail',
        policy: 'trusted-native',
        allowedTools: ['write_artifact', 'submit_result'],
        startupCommands: ['/ponytail ultra'],
        resources: resource.extensions.map((entry) => ({
          resourceHash: resource.hash,
          entry,
          kind: 'extension',
          required: true,
        })),
      });
      const fixture = resolve(
        import.meta.dirname,
        '../../../packages/adapter-pi/test/fixtures/harness-role-worker.ts',
      );
      const store = new InMemoryRunStore();
      const transport = new InProcessTransport(
        new Coordinator({
          clock,
          ids: new SequentialIdFactory(),
          store,
          harnesses,
          models: {
            resolve: (profile) => ({
              ok: true,
              snapshot: { profile, provider: 'faux', modelId: 'faux-1', auth: 'api_key' },
            }),
          },
          agents: new PiAgentAdapter({
            spawn: () => processChannel(fixture),
            spawnSdk: () => sdkProcessChannel(fixture),
            harness: (input) => harnesses.runtimeResources(input),
            credentials: async () => 'fixture-access-token',
          }),
        }),
      );
      const definition = linearCorral(['a', 'b']);
      definition.roles[0]!.harness = { profileId: profile.profileId, revision: profile.revision };
      const start = await transport.startRun({
        schemaVersion: '0.1',
        commandId: 'start',
        definition,
        mode: 'live',
      });
      expect(start.receipt.status).toBe('applied');
      const runId = start.runId!;
      const projection = await waitForProjection(transport, runId, (p) =>
        ['succeeded', 'failed', 'cancelled'].includes(p.status),
      );
      expect(projection.status).toBe('succeeded');
      const artifacts = Object.values(projection.artifacts).filter(
        (artifact) => artifact.authorExecutionId,
      );
      const results = artifacts.map((artifact) =>
        JSON.parse(store.getArtifactText(runId, artifact.artifactVersionId) ?? '{}'),
      );
      expect(results).toEqual([{ hasPonytail: true }, { hasPonytail: false }]);
      expect(
        store.readEvents(runId, 0).filter((event) => event.type === 'harness.loaded'),
      ).toHaveLength(1);
      expect(Object.values(projection.modelCalls)).toHaveLength(6);
      expect(JSON.stringify(store.readEvents(runId, 0))).not.toContain(root);
      expect(JSON.stringify(store.readEvents(runId, 0))).not.toContain('fixture-access-token');
    } finally {
      harnesses.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  180_000,
);
