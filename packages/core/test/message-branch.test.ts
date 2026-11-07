import { type AgentHost, type AgentStartInput, canonicalJson } from '@corral/contracts';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { expect, it, vi } from 'vitest';
import {
  Coordinator,
  exportRunArchive,
  InMemoryRunStore,
  InProcessTransport,
  openRunArchive,
  waitForProjection,
} from '../src/index.ts';

const hash = (value: unknown) => bytesToHex(sha256(utf8ToBytes(canonicalJson(value))));
it('refuses retired message checkpoints while original-request reruns remain explicit and idempotent', async () => {
  const store = new InMemoryRunStore();
  const clock = new FakeClock(),
    started = new Gate(),
    finished = new Gate(),
    branchStarted = new Gate();
  let agentStarts = 0;
  let host!: AgentHost, branchInput!: AgentStartInput;
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    store,
    runtimeRecovery: { confirm: async () => {} },
    models: {
      resolve: (profile) => ({
        ok: true,
        snapshot: { profile, provider: 'fixture', modelId: 'fixture', auth: 'api_key' },
      }),
    },
    agents: {
      start: async (input, h) => {
        agentStarts++;
        if (input.runId === 'run_0001') {
          host = h;
          started.open();
          return {
            cancel: async () => finished.open(),
            waitForSettlement: async () => {
              await finished.wait();
              return { outcome: 'failed' };
            },
          };
        }
        branchInput = input;
        branchStarted.open();
        return { cancel: async () => {}, waitForSettlement: async () => ({ outcome: 'failed' }) };
      },
    },
  });
  const definition = linearCorral(['writer']);
  definition.roles[0]!.allowedCollaborationTools.push('read_artifact');
  const source = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'source_branch',
    definition,
    mode: 'live',
  });
  await started.wait();
  const context = {
    messages: [{ role: 'user', content: 'Before the selected message.', timestamp: 1 }],
  };
  const checkpoint = await host.checkpointContext!({
    version: 1,
    piVersion: '1.3.0',
    runtime: 'pi-core',
    context,
    contextHash: hash(context),
  });
  const first = await host.invokeTool({
    name: 'write_artifact',
    args: { text: 'Selected result.' },
  });
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error('write failed');
  const later = {
    messages: [{ role: 'user', content: 'FUTURE SECRET IN ANOTHER BRANCH', timestamp: 2 }],
  };
  await host.checkpointContext!({
    version: 1,
    piVersion: '1.3.0',
    runtime: 'pi-core',
    context: later,
    contextHash: hash(later),
  });
  await host.invokeTool({ name: 'write_artifact', args: { text: 'FUTURE OUTPUT' } });
  const point = {
    sourceRunId: source.runId!,
    artifactVersionId: String(first.result.artifactVersionId),
  };
  const preview = coordinator.branchPreview(point);
  expect(preview.checkpointId).toBe(checkpoint!.checkpointId);
  finished.open();
  await waitForProjection(
    new InProcessTransport(coordinator),
    source.runId!,
    (projection) => projection.status === 'failed',
  );
  expect(store.getArtifactText(source.runId!, point.artifactVersionId)).toBeNull();
  expect(store.getArtifactText(source.runId!, checkpoint!.contextRef)).toBeNull();
  expect(
    coordinator.getSnapshot(source.runId!).projection.artifacts[point.artifactVersionId],
  ).toMatchObject({
    artifactVersionId: point.artifactVersionId,
    bodyAvailable: false,
  });
  expect(() => coordinator.branchPreview(point)).toThrow(/body is unavailable/);
  const prepare = vi.fn(async () => ({ sessionId: 'session_branch' }));
  const request = { ...point, commandId: 'branch_selected', expectedHash: preview.hash };
  const refused = await coordinator.branchRun(request, prepare);
  expect(refused.runId).toBeNull();
  expect(refused.receipt.error?.code).toBe('STORAGE_UNAVAILABLE');
  expect(prepare).not.toHaveBeenCalled();
  expect(agentStarts).toBe(1);
  const bundle = openRunArchive(
    exportRunArchive(store, source.runId!, { privateTranscript: true }),
  );
  expect(bundle.visibility).toBe('private');
  if (bundle.visibility === 'private') {
    expect(bundle.artifacts).not.toHaveProperty(point.artifactVersionId);
    expect(bundle.unavailableBodyRefs).toContain(point.artifactVersionId);
  }
  const initialPoint = { sourceRunId: source.runId!, requestStart: true as const };
  const initialPreview = coordinator.branchPreview(initialPoint);
  expect(initialPreview.sourceSeq).toBe(1);
  expect(
    (
      await coordinator.branchRun(
        { ...initialPoint, commandId: 'wrong_hash', expectedHash: '0'.repeat(64) },
        prepare,
      )
    ).receipt.status,
  ).toBe('rejected');
  expect(prepare).not.toHaveBeenCalled();
  const initialRequest = {
    ...initialPoint,
    commandId: 'branch_original_request',
    expectedHash: initialPreview.hash,
  };
  const initialBranch = await coordinator.branchRun(initialRequest, prepare);
  expect(initialBranch.runId).not.toBeNull();
  await branchStarted.wait();
  expect(branchInput.resumeContext).toBeUndefined();
  expect(JSON.stringify(branchInput)).not.toContain('FUTURE');
  expect(JSON.stringify(branchInput)).not.toContain('Before the selected message.');
  expect(await coordinator.branchRun(initialRequest, prepare)).toEqual(initialBranch);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(agentStarts).toBe(2);
  expect(coordinator.getRunSnapshot(initialBranch.runId!)?.definition.input.brief).toBe(
    linearCorral(['writer']).input.brief,
  );
  expect(
    coordinator.getRunSnapshot(initialBranch.runId!)?.branchedFrom?.artifactVersionId,
  ).toBeNull();
});
