import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AutoStart } from '@corral/core';
import {
  autoDefinition,
  Coordinator,
  createAutoStarter,
  InProcessTransport,
  waitForProjection,
} from '@corral/core';
import {
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { expect, it } from 'vitest';
import { openDatabase, SqliteRunStore } from '../src/index.ts';

it('[TC-AUTO-003-H] [TC-AUTO-003-N] replays an exact legacy auto command after migration and rejects changed requests', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'corral-auto-legacy-'));
  const file = join(directory, 'workspace.db');
  let db = openDatabase(file);
  try {
    const open = () => {
      const coordinator = new Coordinator({
        store: new SqliteRunStore(db),
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        agents: new ScriptedAgentAdapter({ turns: 1 }),
      });
      const runtime = new InProcessTransport(coordinator);
      return { coordinator, runtime };
    };
    const first = open();
    const source = first.coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_source',
      definition: linearCorral(['writer']),
      mode: 'mock',
    });
    if (!source.runId) throw new Error('source run expected');
    const output = await waitForProjection(
      first.runtime,
      source.runId,
      (p) => p.status === 'succeeded',
    );
    const artifactVersionId = output.output?.artifactVersionIds[0];
    if (!artifactVersionId) throw new Error('source result expected');
    const request: AutoStart = {
      commandId: 'cmd_legacy_auto',
      sessionId: 'session_legacy',
      brief: 'Explain the previous result.',
      criteria: ['Keep the original numbers.'],
      mode: 'mock',
      choice: { modelProfile: 'model-b', reasoning: { mode: 'fixed', level: 'low' } },
      startFrom: { runId: source.runId, artifactVersionId },
      references: [{ kind: 'file', path: 'a.txt' }],
    };
    const definition = autoDefinition({
      id: 'auto_legacy',
      template: 'single',
      brief: request.brief,
      criteria: request.criteria,
      choice: request.choice,
      fileTools: false,
    });
    // Version 1 stored the router cost in the definition and no original request hash.
    definition.limits = {
      ...definition.limits,
      maxModelCalls: definition.limits.maxModelCalls - 1,
      maxOutputTokens: definition.limits.maxOutputTokens - 30,
    };
    const raw = {
      schemaVersion: '0.1' as const,
      commandId: request.commandId,
      definition,
      mode: request.mode,
      sessionId: request.sessionId,
      startFrom: request.startFrom,
      references: request.references,
      autoRoute: {
        template: 'single' as const,
        templateVersion: 1,
        source: 'model' as const,
        reason: 'Direct.',
        modelProfile: request.choice.modelProfile,
        reasoning: request.choice.reasoning,
        inputHash: createHash('sha256').update(request.brief).digest('hex'),
        usage: { inputTokens: 100, outputTokens: 30 },
      },
    };
    const prior = first.coordinator.startRun(raw);
    if (!prior.runId) throw new Error('legacy auto run expected');
    await waitForProjection(first.runtime, prior.runId, (p) => p.status === 'succeeded');
    const defaultRequest = { ...request, commandId: 'cmd_legacy_default' };
    delete defaultRequest.criteria;
    const defaultPrior = first.coordinator.startRun({
      ...raw,
      commandId: defaultRequest.commandId,
      definition: {
        ...definition,
        input: { brief: request.brief, criteria: ['Do what the request asks.'] },
      },
    });
    if (!defaultPrior.runId) throw new Error('legacy default-criteria run expected');
    await waitForProjection(first.runtime, defaultPrior.runId, (p) => p.status === 'succeeded');
    const refusal = {
      ...request,
      commandId: 'cmd_legacy_refusal',
      references: [{ kind: 'run' as const, runId: 'run_missing' }],
    };
    first.coordinator.startRun({
      ...raw,
      commandId: refusal.commandId,
      references: refusal.references,
    });
    db.exec(
      'DROP TABLE web_source_evidence; DROP TABLE message_branches; DROP TABLE session_search_v1; DROP TABLE session_search_state_v1; DROP TABLE checkpoint_restores; DROP TABLE file_checkpoints; DROP TABLE input_images; ALTER TABLE commands DROP COLUMN original_request_hash',
    );
    db.pragma('user_version = 13');
    db.close();
    db = openDatabase(file);
    const restarted = open();
    let calls = 0;
    const starter = createAutoStarter({
      startRun: (next) => restarted.coordinator.startRun(next),
      previousStart: (id, requestHash, original) => {
        const previous = restarted.coordinator.startResult(id, requestHash, original);
        return previous
          ? {
              ...previous,
              autoRoute: previous.runId
                ? (restarted.coordinator.getRunSnapshot(previous.runId)?.autoRoute ?? null)
                : null,
            }
          : null;
      },
      route: async () => {
        calls++;
        throw new Error('a legacy retry must not call the model');
      },
    });
    const retry = await starter.start(request, { fileTools: true });
    expect(retry.runId).toBe(prior.runId);
    expect(retry.receipt).toEqual(prior.receipt);
    expect((await starter.start(defaultRequest, { fileTools: false })).runId).toBe(
      defaultPrior.runId,
    );
    const withoutStart = { ...request };
    delete withoutStart.startFrom;
    const withoutCriteria = { ...request };
    delete withoutCriteria.criteria;
    for (const changed of [
      { ...request, brief: 'A different question.' },
      { ...request, choice: { modelProfile: 'model-a' } },
      {
        ...request,
        choice: { ...request.choice, reasoning: { mode: 'provider_default' as const } },
      },
      { ...request, mode: 'live' as const },
      { ...request, sessionId: 'session_other' },
      withoutStart,
      { ...request, references: [] },
      { ...request, criteria: ['Changed criteria.'] },
      withoutCriteria,
      refusal,
    ]) {
      const result = await starter.start(changed, { fileTools: false });
      expect(result.runId).toBeNull();
      expect(result.receipt.error?.code).toBe('IDEMPOTENCY_CONFLICT');
    }
    expect(calls).toBe(0);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
