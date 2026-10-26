import { type AgentHost, type AgentStartInput, canonicalJson } from '@corral/contracts';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { expect, it } from 'vitest';
import {
  Coordinator,
  exportRunArchive,
  InMemoryRunStore,
  InProcessTransport,
  openRunArchive,
  waitForProjection,
} from '../src/index.ts';

const hash = (value: unknown) => bytesToHex(sha256(utf8ToBytes(canonicalJson(value))));
it('a message branch uses only its past checkpoint and keeps later messages in the source', async () => {
  const store = new InMemoryRunStore();
  const clock = new FakeClock(),
    started = new Gate(),
    finished = new Gate(),
    branchStarted = new Gate();
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
  finished.open();
  await waitForProjection(
    new InProcessTransport(coordinator),
    source.runId!,
    (projection) => projection.status === 'failed',
  );
  const point = {
    sourceRunId: source.runId!,
    artifactVersionId: String(first.result.artifactVersionId),
  };
  const preview = coordinator.branchPreview(point);
  expect(preview.checkpointId).toBe(checkpoint!.checkpointId);
  const prepare = async () => ({ sessionId: 'session_branch' });
  const request = { ...point, commandId: 'branch_selected', expectedHash: preview.hash };
  expect(
    (
      await coordinator.branchRun(
        { ...request, commandId: 'wrong_branch', expectedHash: '0'.repeat(64) },
        prepare,
      )
    ).receipt.status,
  ).toBe('rejected');
  const result = await coordinator.branchRun(request, prepare);
  expect(result.runId).not.toBeNull();
  await branchStarted.wait();
  expect(JSON.stringify(branchInput)).toContain('Selected result.');
  expect(JSON.stringify(branchInput)).toContain('Before the selected message.');
  expect(JSON.stringify(branchInput)).not.toContain('FUTURE');
  const inherited = branchInput.resumeContext?.sources?.find(
    (source) => source.text === definition.input.brief,
  );
  expect(inherited).toBeDefined();
  expect(store.getArtifactText(result.runId!, inherited!.sourceRef)).toBe(definition.input.brief);
  expect(coordinator.getRunSnapshot(result.runId!)?.branchedFrom).toMatchObject({
    runId: source.runId,
    artifactVersionId: point.artifactVersionId,
    checkpointId: checkpoint!.checkpointId,
  });
  expect(await coordinator.branchRun(request, prepare)).toEqual(result);
  expect(
    openRunArchive(exportRunArchive(store, result.runId!, { privateTranscript: true })),
  ).toBeDefined();
  await waitForProjection(
    new InProcessTransport(coordinator),
    result.runId!,
    (projection) => projection.status === 'failed',
  );
  const initialPoint = { sourceRunId: source.runId!, requestStart: true as const };
  const initialPreview = coordinator.branchPreview(initialPoint);
  expect(initialPreview.sourceSeq).toBe(1);
  const initialBranch = await coordinator.branchRun(
    { ...initialPoint, commandId: 'branch_original_request', expectedHash: initialPreview.hash },
    prepare,
  );
  expect(initialBranch.runId).not.toBeNull();
  expect(coordinator.getRunSnapshot(initialBranch.runId!)?.definition.input.brief).toBe(
    linearCorral(['writer']).input.brief,
  );
  expect(
    coordinator.getRunSnapshot(initialBranch.runId!)?.branchedFrom?.artifactVersionId,
  ).toBeNull();
});
