import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PiAgentAdapter, processChannel, WORKER_ENTRY } from '@corral/adapter-pi';
import { type RunEvent, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import {
  Coordinator,
  createAutoStarter,
  InProcessTransport,
  waitForProjection,
} from '@corral/core';
import {
  DEFAULT_PROFILES,
  FileCredentialStore,
  installationId,
  ModelRegistry,
  RandomIdFactory,
  systemClock,
  userConfigDir,
} from '@corral/server';
import { builtinModels, getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { expect, it } from 'vitest';
import { candidateHash } from '../../tools/release/candidate.ts';

// Explicit opt-in. Existing GPT sign-in only; text fixture, at most 24 requests and 4 minutes.
it.skipIf(process.env.CORRAL_ULTRA_LIVE !== '1')(
  '[TC-ULTRA-003-H] the selected GPT models synthesize and cross-review through real OAuth workers',
  async () => {
    const candidate = candidateHash();
    const configDir = userConfigDir();
    const credentials = new FileCredentialStore(configDir);
    const registry = new ModelRegistry(builtinModels({ credentials }), DEFAULT_PROFILES, {
      credentials,
      getDeviceId: () => installationId(configDir),
      subscriptionModels: (provider) =>
        provider === 'openai'
          ? new Set(getBuiltinModels('openai-codex').map((model) => model.id))
          : null,
    });
    await registry.refreshStatus();
    const profiles = DEFAULT_PROFILES.map((profile) => profile.id);
    for (const profile of profiles) {
      const model = registry.resolve(profile, 'live');
      if (!model.ok || model.snapshot.auth !== 'oauth')
        throw new Error('Ultra live fixture requires the existing GPT subscription sign-in');
    }
    const adapter = new PiAgentAdapter({
      spawn: () => processChannel(WORKER_ENTRY),
      credentials: (model) => registry.credentials(model),
    });
    let calls = 0;
    const events: RunEvent[] = [];
    const coordinator = new Coordinator({
      clock: systemClock,
      ids: new RandomIdFactory(),
      models: registry,
      agents: {
        start: (input, host) =>
          adapter.start(input, {
            ...host,
            prepareModelRequest: async (...args) => {
              if (++calls > 24) throw new Error('Ultra live fixture call cap reached');
              return host.prepareModelRequest(...args);
            },
          }),
      },
    });
    const starter = createAutoStarter({
      startRun: (request) => coordinator.startRun(request),
      resolveUltra: (selection, primary, mode) =>
        coordinator.resolveUltra(selection, primary, mode),
    });
    const result = await starter.start(
      {
        commandId: 'ultra_live_fixture',
        brief:
          'This is a small verification fixture, requiring no research, files, delegation or clarification. Produce exactly one sentence: Blue is a primary colour. Each role should complete its assigned artifact and submit it promptly. Do not claim project tests were run.',
        criteria: [
          'The final answer is exactly: Blue is a primary colour.',
          'Review the supplied final artifact against these criteria.',
        ],
        mode: 'live',
        qualityPreset: 'ultra',
        choice: { modelProfile: profiles[0]! },
        ultra: { version: 1, modelProfiles: profiles, verifierProfile: profiles[1]! },
      },
      { fileTools: false },
    );
    if (!result.runId) throw new Error(JSON.stringify(result.receipt.error));
    const runId = result.runId;
    const off = coordinator.subscribe(runId, 0, (event) => events.push(event));
    const cancel = () =>
      coordinator.submit({
        schemaVersion: '0.1',
        commandId: 'ultra_live_cancel',
        runId,
        type: 'cancel',
        payload: { scope: { kind: 'run' }, reason: 'live fixture finished' },
      });
    const deadline = setTimeout(cancel, 240000);
    let passed = false;
    try {
      const final = await waitForProjection(
        new InProcessTransport(coordinator),
        runId,
        (projection) =>
          TERMINAL_RUN_STATUSES.has(projection.status) || projection.status === 'awaiting_user',
      );
      const summary = {
        candidate,
        status: final.status,
        reason: final.statusReason,
        requests: calls,
        budget: {
          modelCalls: final.budget.modelCalls,
          spent: final.budget.spent,
          unknown: final.budget.unknownOutstanding,
        },
        nodes: Object.values(final.executions).map((execution) => ({
          node: execution.nodeId,
          status: execution.status,
        })),
        reasoning: events.flatMap((event) =>
          event.type === 'model.payload_recorded' ? [event.payload.reasoning] : [],
        ),
      };
      console.log('[ultra-live]', JSON.stringify(summary));
      expect(final.status).toBe('succeeded');
      expect(final.budget.unknownOutstanding).toBe(0);
      expect(
        summary.nodes.some((node) => node.node === 'synthesize' && node.status === 'succeeded'),
      ).toBe(true);
      expect(
        summary.nodes.some((node) => node.node === 'review' && node.status === 'succeeded'),
      ).toBe(true);
      expect(calls).toBeLessThanOrEqual(24);
      passed = true;
    } finally {
      clearTimeout(deadline);
      cancel();
      off();
      mkdirSync(join(import.meta.dirname, 'test-results'), { recursive: true });
      writeFileSync(
        join(import.meta.dirname, 'test-results/ultra.json'),
        JSON.stringify(
          {
            candidate,
            passed,
            requests: calls,
            completedAt: new Date().toISOString(),
            sameCandidate: candidate === candidateHash(),
          },
          null,
          2,
        ),
      );
    }
  },
  270000,
);
