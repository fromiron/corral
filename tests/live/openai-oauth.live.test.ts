import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAgentAdapter, processChannel, WORKER_ENTRY } from '@corral/adapter-pi';
import { type RunEvent, TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { Coordinator, InProcessTransport, waitForProjection } from '@corral/core';
import {
  DEFAULT_PROFILES,
  FileCredentialStore,
  installationId,
  ModelRegistry,
  RandomIdFactory,
  systemClock,
  userConfigDir,
} from '@corral/server';
import { linearCorral } from '@corral/testkit';
import { builtinModels, getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidateHash } from '../../tools/release/candidate.ts';

// live smoke (manual opt-in, never in CI): real OpenAI requests with the sign-in stored
// by Studio (Settings → Models). Run with:
//   CORRAL_LIVE=1 pnpm test:live
// Each profile makes one short run (at most 3 requests, 256 output tokens each), plus one
// aborted request. Results are recorded by hand in the P3 evidence; no output is asserted for
// quality, only for runtime behaviour.

const enabled = process.env.CORRAL_LIVE === '1';
const candidate = enabled ? candidateHash() : '';
let passedProfiles = 0;
let passedAbort = false;
const configDir = userConfigDir();
const credentials = new FileCredentialStore(configDir);
const models = builtinModels({ credentials });
const registry = new ModelRegistry(models, DEFAULT_PROFILES, {
  credentials,
  getDeviceId: () => installationId(configDir),
  subscriptionModels: (providerId) =>
    providerId === 'openai' ? new Set(getBuiltinModels('openai-codex').map((m) => m.id)) : null,
});
const workspaceDirs: string[] = [];
afterAll(() => {
  for (const dir of workspaceDirs) rmSync(dir, { recursive: true, force: true });
  // Separate live proof for this exact source candidate; ignored by git.
  if (enabled) {
    writeFileSync(
      join(import.meta.dirname, '.last-run.json'),
      `${JSON.stringify({ ranAt: new Date().toISOString(), results, releaseProof: { candidate, passed: passedProfiles === DEFAULT_PROFILES.length && passedAbort && candidate === candidateHash(), completedAt: new Date().toISOString(), callsCap: DEFAULT_PROFILES.length * 3 + 1, outputTokensPerCall: 256 } }, null, 2)}\n`,
    );
  }
});

const results: Record<string, unknown> = {};

function report(label: string, value: unknown) {
  // Counts and ids only: never request text, tokens or headers.
  results[label] = value;
  console.log(`[live] ${label}: ${JSON.stringify(value)}`);
}

describe.skipIf(!enabled)('OpenAI sign-in live smoke', () => {
  beforeAll(async () => {
    if (DEFAULT_PROFILES.length * 3 + 1 > 10)
      throw new Error('Live smoke exceeds its 10 model-call cap');
    await registry.refreshStatus();
    const [openai] = registry.authView();
    if (!openai?.signedIn) {
      throw new Error(
        [
          'No OpenAI sign-in is saved in the server credential store.',
          'Run `pnpm serve`, open the printed link, sign in under Models, stop the server,',
          'then run `CORRAL_LIVE=1 pnpm test:live` again.',
        ].join(' '),
      );
    }
    report('sign-in', { method: openai.method, expiresAt: openai.expiresAt });
  });

  it.each(DEFAULT_PROFILES.map((p) => p.id))(
    'profile %s: one short run with reported usage',
    async (profile) => {
      await registry.refreshStatus();
      const resolution = registry.resolve(profile, 'live');
      if (!resolution.ok) throw new Error(`${profile}: ${resolution.reason}`);
      workspaceDirs.push(mkdtempSync(join(tmpdir(), 'corral-live-')));
      const transport = new InProcessTransport(
        new Coordinator({
          clock: systemClock,
          ids: new RandomIdFactory(),
          models: registry,
          agents: new PiAgentAdapter({
            spawn: () => processChannel(WORKER_ENTRY),
            credentials: (model) => registry.credentials(model),
          }),
        }),
      );
      const definition = linearCorral(['writer'], 'live-smoke');
      definition.input.brief = 'Reply with one short sentence naming a primary colour.';
      for (const role of definition.roles) role.modelProfile = profile;
      definition.limits = { ...definition.limits, maxModelCalls: 3, maxOutputTokensPerCall: 256 };
      const { runId, receipt } = await transport.startRun({
        schemaVersion: '0.1',
        commandId: `cmd_live_${profile}`,
        definition,
        mode: 'live',
      });
      if (!runId) throw new Error(JSON.stringify(receipt.error));
      const events: RunEvent[] = [];
      transport.subscribe(runId, 0, { onEvent: (e) => events.push(e) });
      const final = await waitForProjection(transport, runId, (p) => p.status !== 'running');
      const started = events.find((e) => e.type === 'run.started');
      const usage = events.flatMap((e) => (e.type === 'model.finished' ? [e.payload] : []));
      report(`${profile} status`, {
        status: final.status,
        reason: final.statusReason,
        failedExecutions: Object.values(final.executions).filter((e) => e.error !== null).length,
      });
      report(
        `${profile} model`,
        started?.type === 'run.started' ? started.payload.modelProfiles : null,
      );
      report(
        `${profile} usage`,
        usage.map((u) => ({ ...u.normalizedUsage, certainty: u.certainty })),
      );
      expect(final.status).toBe('succeeded');
      expect(usage.length).toBeGreaterThan(0);
      expect(usage.length).toBeLessThanOrEqual(3);
      expect(usage.every((u) => u.certainty === 'reported')).toBe(true);
      expect(JSON.stringify(events)).not.toMatch(/eyJ|Bearer/);
      passedProfiles += 1;
    },
    120_000,
  );

  it('an aborted request settles as cancelled; its usage is recorded as the provider left it', async () => {
    await registry.refreshStatus();
    let streamed = 0;
    let calls = 0;
    const events: RunEvent[] = [];
    const adapter = new PiAgentAdapter({
      spawn: () => processChannel(WORKER_ENTRY),
      credentials: (model) => registry.credentials(model),
    });
    const coordinator = new Coordinator({
      clock: systemClock,
      ids: new RandomIdFactory(),
      models: registry,
      agents: {
        start: (input, host) =>
          adapter.start(input, {
            ...host,
            prepareModelRequest(...args) {
              if (++calls > 1) throw new Error('Live abort smoke allows one model request');
              return host.prepareModelRequest(...args);
            },
            streamText(chunk) {
              host.streamText?.(chunk);
              if (++streamed === 3)
                coordinator.submit({
                  schemaVersion: '0.1',
                  commandId: 'live_abort_on_stream',
                  runId: input.runId,
                  type: 'cancel',
                  payload: { scope: { kind: 'run' }, reason: 'live stream cancellation fixture' },
                });
            },
          }),
      },
    });
    const transport = new InProcessTransport(coordinator);
    const definition = linearCorral(['writer'], 'live-abort');
    definition.input.brief =
      'Count slowly from one to two hundred, one number per line. Respond as plain text.';
    definition.roles[0]!.modelProfile = 'model-a';
    definition.roles[0]!.allowedWorkTools = [];
    definition.roles[0]!.allowedCollaborationTools = [];
    definition.limits = {
      ...definition.limits,
      maxModelCalls: 1,
      maxOutputTokensPerCall: 256,
      runDeadlineMs: 60000,
    };
    const started = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'live_abort_start',
      definition,
      mode: 'live',
    });
    if (!started.runId) throw new Error('Abort fixture could not start');
    const runId = started.runId;
    const off = transport.subscribe(runId, 0, { onEvent: (event) => events.push(event) });
    const deadline = setTimeout(
      () =>
        coordinator.submit({
          schemaVersion: '0.1',
          commandId: 'live_abort_deadline',
          runId,
          type: 'cancel',
          payload: { scope: { kind: 'run' }, reason: 'live abort fixture deadline' },
        }),
      65000,
    );
    try {
      const final = await waitForProjection(transport, runId, (projection) =>
        TERMINAL_RUN_STATUSES.has(projection.status),
      );
      report('abort', {
        status: final.status,
        modelRequests: calls,
        textChunks: streamed,
        payloads: events.filter((event) => event.type === 'model.payload_recorded').length,
        unknown: final.budget.unknownOutstanding,
      });
      expect(calls).toBe(1);
      expect(streamed).toBeGreaterThanOrEqual(3);
      expect(events.some((event) => event.type === 'model.payload_recorded')).toBe(true);
      expect(final.status).toBe('cancelled');
      passedAbort = true;
    } finally {
      clearTimeout(deadline);
      off();
    }
  }, 90000);
});

describe.runIf(!enabled)('live smoke', () => {
  it('is skipped unless CORRAL_LIVE=1 (it calls OpenAI with your sign-in)', () => {
    expect(enabled).toBe(false);
  });
});
