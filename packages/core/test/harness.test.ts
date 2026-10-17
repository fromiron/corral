import {
  type AgentHost,
  type AgentStartInput,
  canonicalJson,
  type EffectiveHarnessSnapshot,
  type ModelRequestRecord,
  type ToolDescriptor,
} from '@corral/contracts';
import { FakeClock, Gate, linearCorral, SequentialIdFactory } from '@corral/testkit';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it, vi } from 'vitest';
import {
  Coordinator,
  exportRunArchive,
  type FileTools,
  InMemoryRunStore,
  openRunArchive,
} from '../src/index.ts';

const hash = (value: unknown) => bytesToHex(sha256(utf8ToBytes(canonicalJson(value))));
const descriptor: ToolDescriptor = {
  name: 'echo',
  source: 'extension:fixture@1.0.0',
  schemaHash: 'b'.repeat(64),
  exposure: 'direct',
  sideEffect: 'none',
  annotations: { readOnlyHint: true, openWorldHint: false },
};
const snapshot: EffectiveHarnessSnapshot = {
  binding: { profileId: 'writing', revision: 1 },
  snapshotHash: 'a'.repeat(64),
  piVersion: '1.3.0',
  policyRevision: 1,
  policy: 'trusted-native',
  resources: [
    { hash: 'c'.repeat(64), name: 'fixture', version: '1.0.0', kind: 'extension', required: true },
  ],
  allowedTools: ['echo'],
  tools: [],
  diagnostics: [],
};
const record: ModelRequestRecord = {
  purpose: 'turn',
  directiveIds: [],
  contextHash: 'd'.repeat(64),
  contextBytes: 250,
  sections: [],
};
function setup(
  resolve = true,
  selected = snapshot,
  options: { files?: FileTools; fileTools?: boolean } = {},
) {
  const started = new Gate();
  const done = new Gate();
  const store = new InMemoryRunStore();
  const clock = new FakeClock();
  let host!: AgentHost;
  let input!: AgentStartInput;
  const coordinator = new Coordinator({
    clock,
    timers: clock,
    ids: new SequentialIdFactory(),
    store,
    ...(options.files ? { files: options.files } : {}),
    ...(resolve
      ? {
          harnesses: {
            resolve: () => JSON.parse(JSON.stringify(selected)) as EffectiveHarnessSnapshot,
            readSkill: () => ({ text: 'first\nsecond\nthird', sha256: 'e'.repeat(64) }),
          },
        }
      : {}),
    agents: {
      start: async (i, h) => {
        input = i;
        host = h;
        started.open();
        return {
          cancel: async () => done.open(),
          waitForSettlement: async () => {
            await done.wait();
            return { outcome: 'cancelled' as const };
          },
        };
      },
    },
  });
  const definition = linearCorral(['writer']);
  definition.roles[0]!.harness = snapshot.binding;
  if (options.fileTools) definition.roles[0]!.allowedWorkTools = ['read_file', 'write_file'];
  const result = coordinator.startRun({
    schemaVersion: '0.1',
    commandId: 'start',
    definition,
    mode: 'mock',
  });
  return {
    coordinator,
    clock,
    store,
    result,
    started,
    done,
    host: () => host,
    input: () => input,
    events: () => store.readEvents(result.runId!, 0),
  };
}
async function loaded() {
  const s = setup();
  await s.started.wait();
  await s.host().reportHarness!({
    ok: true,
    snapshotHash: snapshot.snapshotHash,
    tools: [descriptor],
    diagnostics: [],
  });
  return s;
}

describe('Coordinator harness boundary (H2)', () => {
  it('[TC-HAR-002-N] an admitted native effect can finish during pause without admitting another call', async () => {
    const s = await loaded();
    const args = {text:'approved'};
    const auth = await s.host().authorizeTool({name:'echo',args});
    await s.host().beginNativeTool!(auth.toolCallId,hash(args));
    s.coordinator.submit({schemaVersion:'0.1',runId:s.input().runId,commandId:'pause_native',type:'pause',payload:{scope:'run'}});
    await expect(s.host().finishNativeTool!(auth.toolCallId,'succeeded')).resolves.toBeUndefined();
    expect(s.events().filter(event=>event.type==='tool.finished' && event.payload.toolCallId===auth.toolCallId)).toHaveLength(1);
    expect(s.coordinator.getSnapshot(s.input().runId).projection.status).not.toBe('running');
    s.coordinator.submit({schemaVersion:'0.1',runId:s.input().runId,commandId:'stop_native',type:'cancel',payload:{scope:{kind:'run'},reason:'done'}});
    s.done.open();
  });
  it('[TC-HAR-010-H] [TC-HAR-010-N] Pi edit/write aliases retain role file permissions and cannot modify skill resources', async () => {
    const execute = vi.fn(async () => ({ path: 'a.txt', sha256: 'a'.repeat(64) }));
    const selected: EffectiveHarnessSnapshot = {
      ...snapshot,
      policy: 'strict',
      resources: [],
      allowedTools: ['edit', 'write'],
    };
    const s = setup(true, selected, { files: { available: () => true, execute }, fileTools: true });
    await s.started.wait();
    await s.host().reportHarness!({
      ok: true,
      snapshotHash: selected.snapshotHash,
      tools: ['edit', 'write'].map((name) => ({
        ...descriptor,
        source: 'corral',
        name,
        sideEffect: 'workspace',
      })),
      diagnostics: [],
    });
    expect(
      await s
        .host()
        .invokeTool({
          name: 'edit',
          args: { path: 'a.txt', edits: [{ oldText: 'one', newText: 'two' }] },
        }),
    ).toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'edit', executionId: s.input().executionId }),
      expect.anything(),
    );
    expect(
      await s
        .host()
        .authorizeTool({
          name: 'write',
          args: { path: 'skills/writing/SKILL.md', content: 'overwrite' },
        }),
    ).toMatchObject({ ok: false });
    expect(
      await s.host().authorizeTool({ name: 'edit', args: { path: 'a.txt', edits: [] } }),
    ).toMatchObject({ ok: false });
    const denied = setup(true, selected, { files: { available: () => true, execute } });
    await denied.started.wait();
    await denied.host().reportHarness!({
      ok: true,
      snapshotHash: selected.snapshotHash,
      tools: [{ ...descriptor, source: 'corral', name: 'write', sideEffect: 'workspace' }],
      diagnostics: [],
    });
    expect(
      await denied
        .host()
        .authorizeTool({ name: 'write', args: { path: 'a.txt', content: 'overwrite' } }),
    ).toMatchObject({ ok: false });
    s.done.open();
    denied.done.open();
  });
  it('[TC-HAR-007-N] ending an execution closes its outstanding dialog before another attempt can answer', async () => {
    const s = await loaded();
    const answer = s.host().requestExtensionUi!({
      kind: 'input',
      title: 'Name',
      placeholder: '',
      timeoutMs: 1000,
    });
    s.done.open();
    await vi.waitFor(() =>
      expect(s.events().some((e) => e.type === 'execution.settled')).toBe(true),
    );
    expect(s.events().filter((e) => e.type === 'extension.ui_expired')).toMatchObject([
      { payload: { reason: 'execution_ended' } },
    ]);
    expect(await answer).toEqual({ status: 'cancelled' });
  });
  it('[TC-HAR-007-H] UI answers match the execution attempt and command replay is idempotent; bodies stay in private records', async () => {
    const s = await loaded();
    const answer = s.host().requestExtensionUi!({
      kind: 'select',
      title: 'Private question',
      options: ['One', 'Two'],
      timeoutMs: 1000,
    });
    const event = s.events().find((e) => e.type === 'extension.ui_requested');
    if (!event || event.type !== 'extension.ui_requested') throw new Error('request missing');
    expect(JSON.stringify(s.events())).not.toContain('Private question');
    expect(s.store.getArtifactText(s.input().runId, event.payload.bodyRef)).toContain(
      'Private question',
    );
    const command = {
      schemaVersion: '0.1' as const,
      commandId: 'answer',
      runId: s.input().runId,
      expectedControlRevision: 0,
      type: 'answer_extension_ui' as const,
      payload: {
        requestId: event.payload.requestId,
        executionId: s.input().executionId,
        attemptNo: s.input().attemptNo,
        value: 'One',
      },
    };
    expect(
      s.coordinator.submit({
        ...command,
        commandId: 'wrong_attempt',
        payload: { ...command.payload, attemptNo: 999 },
      }).status,
    ).toBe('rejected');
    expect(
      s.coordinator.submit({
        ...command,
        commandId: 'wrong_option',
        payload: { ...command.payload, value: 'Other' },
      }).status,
    ).toBe('rejected');
    expect(
      s.coordinator.submit({ ...command, commandId: 'wrong_revision', expectedControlRevision: 99 })
        .error?.code,
    ).toBe('STALE_CONTROL_REVISION');
    const receipt = s.coordinator.submit(command);
    expect(receipt.status).toBe('applied');
    expect(await answer).toEqual({ status: 'answered', value: 'One' });
    expect(s.coordinator.submit(command)).toEqual(receipt);
    expect(s.coordinator.submit({ ...command, commandId: 'late_answer' }).status).toBe('rejected');
    expect(s.events().filter((e) => e.type === 'extension.ui_answered')).toHaveLength(1);
    expect(() =>
      openRunArchive(exportRunArchive(s.store, s.input().runId, { privateTranscript: true })),
    ).not.toThrow();
    s.done.open();
  });

  it('[TC-HAR-007-N] UI timeouts and cancellation close the exact request and reject a late reply', async () => {
    const s = await loaded();
    const timed = s.host().requestExtensionUi!({
      kind: 'confirm',
      title: 'Continue?',
      message: 'Confirm.',
      timeoutMs: 100,
    });
    s.clock.advance(101);
    expect(await timed).toEqual({ status: 'expired' });
    const waiting = s.host().requestExtensionUi!({
      kind: 'input',
      title: 'Name',
      placeholder: '',
      timeoutMs: 1000,
    });
    const event = s.events().findLast((e) => e.type === 'extension.ui_requested');
    if (!event || event.type !== 'extension.ui_requested') throw new Error('request missing');
    s.coordinator.submit({
      schemaVersion: '0.1',
      commandId: 'cancel_ui_run',
      runId: s.input().runId,
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'cancel test' },
    });
    expect(await waiting).toEqual({ status: 'cancelled' });
    expect(
      s.coordinator.submit({
        schemaVersion: '0.1',
        commandId: 'late_ui',
        runId: s.input().runId,
        expectedControlRevision: 0,
        type: 'answer_extension_ui',
        payload: {
          requestId: event.payload.requestId,
          executionId: s.input().executionId,
          attemptNo: s.input().attemptNo,
          value: 'Too late',
        },
      }).status,
    ).toBe('rejected');
    expect(s.events().filter((e) => e.type === 'extension.ui_expired')).toHaveLength(2);
  });
  it('[TC-HAR-005-H] [TC-HAR-005-N] read uses the skill broker and cannot read an unbound skill or worktree without role permission', async () => {
    const selected: EffectiveHarnessSnapshot = {
      ...snapshot,
      policy: 'strict',
      allowedTools: ['read'],
      resources: [
        {
          hash: 'c'.repeat(64),
          name: 'fixture',
          version: '1.0.0',
          kind: 'skill',
          required: true,
          entry: 'skills/writing/SKILL.md',
          skillName: 'writing',
          skillMode: 'auto',
        },
      ],
    };
    const s = setup(true, selected);
    await s.started.wait();
    await s.host().reportHarness!({
      ok: true,
      snapshotHash: selected.snapshotHash,
      tools: [{ ...descriptor, name: 'read', source: 'corral' }],
      diagnostics: [],
    });
    const result = await s
      .host()
      .invokeTool({ name: 'read', args: { path: 'skills/writing/SKILL.md', offset: 2, limit: 1 } });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.result).toMatchObject({ text: 'first\nsecond\nthird', sha256: 'e'.repeat(64) });
    for (const path of [
      'skills/other/SKILL.md',
      'skills/writing/../other',
      'source.ts',
      '/etc/passwd',
    ])
      expect((await s.host().authorizeTool({ name: 'read', args: { path } })).ok).toBe(false);
    const outOfRange = await s
      .host()
      .invokeTool({ name: 'read', args: { path: 'skills/writing/SKILL.md', offset: 20 } });
    expect(outOfRange.ok).toBe(false);
    s.done.open();
  });
  it('[TC-HAR-009-N] rejects an unresolved profile before creating a Run', () => {
    const s = setup(false);
    expect(s.result.runId).toBeNull();
    expect(s.result.receipt.status).toBe('rejected');
    expect(s.store.listRuns()).toEqual([]);
  });

  it('[TC-HAR-003-H] pins the snapshot, requires load acknowledgement and records each request with its budget reservation', async () => {
    const s = setup();
    await s.started.wait();
    expect(s.input().harness).toEqual(snapshot);
    expect(s.events().find((event) => event.type === 'run.started')?.payload).toMatchObject({
      harnesses: { [s.input().role.id]: snapshot },
    });
    await expect(s.host().prepareModelRequest(record)).rejects.toThrow(/harness/i);
    await s.host().reportHarness!({
      ok: true,
      snapshotHash: snapshot.snapshotHash,
      tools: [descriptor],
      diagnostics: [],
    });
    const permit = await s.host().prepareModelRequest(record);
    expect(s.events().filter((e) => e.type === 'model.request_recorded')).toMatchObject([
      { payload: { modelCallId: permit.modelCallId, ...record } },
    ]);
    expect(s.events().filter((e) => e.type === 'budget.reserved')).toHaveLength(1);
    const archived = openRunArchive(
      exportRunArchive(s.store, s.input().runId, { privateTranscript: true }),
    );
    expect(archived.visibility === 'private' && archived.snapshot.harnesses).toEqual({
      [s.input().role.id]: snapshot,
    });
    await expect(s.host().prepareModelRequest()).rejects.toThrow(/record/i);
    s.done.open();
  });

  it('[TC-HAR-002-H] native calls record unmanaged ownership and settle once', async () => {
    const s = await loaded();
    const args = { text: 'private body', path: '/private/path' };
    const auth = await s.host().authorizeTool({ name: 'echo', args });
    expect(auth.ok).toBe(true);
    await s.host().beginNativeTool!(auth.toolCallId, hash(args));
    await s.host().finishNativeTool!(auth.toolCallId, 'succeeded');
    await expect(s.host().finishNativeTool!(auth.toolCallId, 'succeeded')).rejects.toThrow();
    expect(s.events().filter((e) => e.type === 'tool.allowed')).toMatchObject([
      { payload: { policyVersion: 'role-allowlist@2' } },
    ]);
    expect(s.events().filter((e) => e.type === 'tool.started')).toMatchObject([
      { payload: { management: 'unmanaged_native' } },
    ]);
    expect(s.events().filter((e) => e.type === 'tool.finished')).toHaveLength(1);
    expect(JSON.stringify(s.events())).not.toContain('private body');
    expect(JSON.stringify(s.events())).not.toContain('/private/path');
    s.done.open();
  });

  it('[TC-HAR-008-N] the harness allowlist also restricts Corral tools the role normally allows', async () => {
    const s = setup();
    await s.started.wait();
    await s.host().reportHarness!({
      ok: true,
      snapshotHash: snapshot.snapshotHash,
      tools: [descriptor, { ...descriptor, name: 'write_artifact', source: 'corral' }],
      diagnostics: [],
    });
    expect(
      (
        await s
          .host()
          .authorizeTool({ name: 'write_artifact', args: { text: 'not allowed by this profile' } })
      ).ok,
    ).toBe(false);
    s.done.open();
  });

  it('[TC-HAR-002-N] changed arguments, duplicate starts and late reports cannot execute or settle again', async () => {
    const s = await loaded();
    const args = { text: 'approved' };
    const auth = await s.host().authorizeTool({ name: 'echo', args });
    args.text = 'mutated';
    await expect(s.host().beginNativeTool!(auth.toolCallId, hash(args))).rejects.toThrow();
    await s.host().beginNativeTool!(auth.toolCallId, hash({ text: 'approved' }));
    await expect(
      s.host().beginNativeTool!(auth.toolCallId, hash({ text: 'approved' })),
    ).rejects.toThrow();
    s.coordinator.submit({
      schemaVersion: '0.1',
      runId: s.result.runId!,
      commandId: 'cancel',
      type: 'cancel',
      payload: { scope: { kind: 'run' }, reason: 'stop' },
    });
    await expect(s.host().finishNativeTool!(auth.toolCallId, 'succeeded')).rejects.toThrow();
    expect(s.events().filter((e) => e.type === 'tool.finished')).toHaveLength(0);
    s.done.open();
  });

  it('[TC-HAR-003-N] rejects mismatched reports and foreign directive IDs; attaches only actual queued directives', async () => {
    const s = setup();
    await s.started.wait();
    await expect(
      s.host().reportHarness!({
        ok: true,
        snapshotHash: 'f'.repeat(64),
        tools: [],
        diagnostics: [],
      }),
    ).rejects.toThrow();
    await s.host().reportHarness!({
      ok: true,
      snapshotHash: snapshot.snapshotHash,
      tools: [descriptor],
      diagnostics: [],
    });
    await expect(
      s.host().prepareModelRequest({ ...record, directiveIds: ['foreign'] }),
    ).rejects.toThrow();
    s.coordinator.submit({
      schemaVersion: '0.1',
      runId: s.result.runId!,
      commandId: 'steer',
      type: 'steer',
      payload: {
        targetExecutionId: s.input().executionId,
        text: 'Keep citations.',
        delivery: 'next_request',
      },
    });
    const queued = s.host().pendingDirectives!();
    expect(queued).toHaveLength(1);
    const first = await s.host().prepareModelRequest(record);
    expect(first.directives).toEqual([]);
    await s.host().observe({
      kind: 'model_completed',
      modelCallId: first.modelCallId,
      text: '',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const second = await s
      .host()
      .prepareModelRequest({ ...record, directiveIds: queued.map((d) => d.directiveId) });
    expect(second.directives).toEqual(queued);
    s.done.open();
  });
});
