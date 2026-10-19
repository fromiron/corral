import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PiAgentAdapter, processChannel, WORKER_ENTRY } from '@corral/adapter-pi';
import {
  Coordinator,
  InProcessTransport,
  parseWorkspaceConfig,
  waitForProjection,
} from '@corral/core';
import {
  createLiveModels,
  endpointsFrom,
  ModelRegistry,
  RandomIdFactory,
  registerEndpoints,
  systemClock,
} from '@corral/server';
import { linearCorral } from '@corral/testkit';
import { expect, it } from 'vitest';
import { candidateHash, ROOT } from '../../tools/release/candidate.ts';

// Explicit opt-in only. At most 3 inference requests, 4096 output tokens per request; no file tools.
it.skipIf(process.env.CORRAL_HIVE_LIVE !== '1')(
  'Hive DeepSeek high: actual worker, reported usage and configured model identity',
  async () => {
    const config = parseWorkspaceConfig(
      JSON.parse(readFileSync(join(ROOT, '.corral/config.json'), 'utf8')),
    );
    if (!config.ok) throw new Error('invalid workspace config');
    const profile = config.config.modelProfiles?.find((p) => p.id === 'deepseek-hive');
    if (!profile || profile.model !== 'deepseek-ai/deepseek-v4.1-flash-1017')
      throw new Error('Hive profile is not configured');
    const endpoints = endpointsFrom(config.config.modelProviders);
    const endpoint = endpoints.get(profile.provider);
    if (endpoint?.origin !== 'https://api-cdn.thehive.ai')
      throw new Error('unexpected Hive destination');
    const live = createLiveModels();
    registerEndpoints(live.models, endpoints);
    const registry = new ModelRegistry(live.models, [profile], {
      credentials: live.credentials,
      getDeviceId: live.getDeviceId,
      endpoints,
    });
    await registry.refreshStatus();
    if (!registry.resolve(profile.id, 'live').ok) throw new Error('Hive credential is unavailable');
    const coordinator = new Coordinator({
      clock: systemClock,
      ids: new RandomIdFactory(),
      models: registry,
      agents: new PiAgentAdapter({
        spawn: () => processChannel(WORKER_ENTRY),
        credentials: (model) => registry.credentials(model),
        endpoint: (model) => registry.endpointOf(model),
      }),
    });
    const transport = new InProcessTransport(coordinator);
    const marker = `HIVE_CHECK_${randomUUID().replaceAll('-', '')}`;
    const definition = linearCorral(['writer'], 'hive-connection-check');
    definition.input = {
      brief: `State the configured provider ID and configured model ID supplied by the host, and include ${marker}. Do not guess the provider's internal implementation. Save the short answer with write_artifact, then submit_result.`,
      criteria: ['Report the configured model and the supplied marker.'],
    };
    definition.roles[0]!.modelProfile = profile.id;
    definition.roles[0]!.reasoning = { mode: 'fixed', level: 'high' };
    definition.limits = {
      ...definition.limits,
      maxModelCalls: 3,
      maxOutputTokensPerCall: 4096,
      maxOutputTokens: 12288,
      runDeadlineMs: 150000,
      modelTimeoutMs: 120000,
    };
    const candidate = candidateHash();
    const started = coordinator.startRun({
      schemaVersion: '0.1',
      commandId: `hive_${randomUUID()}`,
      definition,
      mode: 'live',
    });
    if (!started.runId) throw new Error('Hive check could not start');
    const runId = started.runId;
    const cancel = () =>
      coordinator.submit({
        schemaVersion: '0.1',
        commandId: `stop_${randomUUID()}`,
        runId,
        type: 'cancel',
        payload: { scope: { kind: 'run' }, reason: 'Hive live verification deadline' },
      });
    const deadline = setTimeout(cancel, 155000);
    try {
      const final = await waitForProjection(transport, runId, (p) =>
        ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(p.status),
      );
      const calls = Object.values(final.modelCalls);
      const output = final.output
        ? ((await transport.getArtifactText(runId, final.output.artifactVersionIds[0]!)) ?? '')
        : '';
      const report = {
        candidate,
        checkedAt: new Date().toISOString(),
        runId,
        status: final.status,
        destination: endpoint.origin,
        provider: profile.provider,
        model: profile.model,
        calls: calls.map((call) => ({
          reasoning: call.reasoning?.resolved,
          wire: call.reasoningWire,
          usage: call.usage,
          certainty: call.certainty,
        })),
        modelCalls: final.budget.modelCalls,
        outputTokens: final.budget.spent,
        unknownOutstanding: final.budget.unknownOutstanding,
        identityMatches: output.includes(profile.model) && output.includes(profile.provider),
        markerMatches: output.includes(marker),
      };
      mkdirSync(join(ROOT, 'test-results/live'), { recursive: true });
      writeFileSync(
        join(ROOT, 'test-results/live/hive-endpoint.json'),
        JSON.stringify(report, null, 2),
      );
      console.log(JSON.stringify(report));
      expect(final.status).toBe('succeeded');
      expect(calls.length).toBeGreaterThan(0);
      expect(final.budget.modelCalls).toBeLessThanOrEqual(3);
      expect(
        calls.every(
          (call) => call.reasoningWire?.value === 'high' && call.certainty === 'reported',
        ),
      ).toBe(true);
      expect(report.identityMatches && report.markerMatches).toBe(true);
    } finally {
      clearTimeout(deadline);
      cancel();
    }
  },
  180000,
);
