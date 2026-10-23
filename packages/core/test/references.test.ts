import type { AgentStartInput, RunReference } from '@corral/contracts';
import { StartRunRequest } from '@corral/contracts';
import {
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  Coordinator,
  createTextAttachment,
  exportRunArchive,
  InMemoryRunStore,
  InProcessTransport,
  openRunArchive,
  SPEC_HARD_CAPS,
  waitForProjection,
} from '../src/index.ts';

// CR-016: `@` references travel with the start request. They point at things; they never grant
// a tool or a path. A result is copied at the version that was chosen, like CR-007's startFrom.

function setup(maxArtifactBytes = SPEC_HARD_CAPS.maxArtifactBytes) {
  const starts: AgentStartInput[] = [];
  const coordinator = new Coordinator({
    store: new InMemoryRunStore(),
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    policy: { ...SPEC_HARD_CAPS, maxArtifactBytes },
    agents: new ScriptedAgentAdapter({
      turns: 1,
      reply: (_turn, input) => `Draft from ${input.nodeId}`,
      beforeReply: async (turn, input) => {
        if (turn === 1) starts.push(JSON.parse(JSON.stringify(input)) as AgentStartInput);
      },
    }),
  });
  return { coordinator, transport: new InProcessTransport(coordinator), starts };
}

async function run(s: ReturnType<typeof setup>, commandId: string, references?: RunReference[]) {
  const definition = linearCorral(['writer']);
  const result = s.coordinator.startRun({
    schemaVersion: '0.1',
    commandId,
    definition,
    mode: 'mock',
    ...(references ? { references } : {}),
  });
  if (!result.runId) return { result, projection: null, definition };
  const projection = await waitForProjection(s.transport, result.runId, (p) =>
    ['succeeded', 'failed', 'cancelled'].includes(p.status),
  );
  return { result, projection, definition };
}

const brief = (s: ReturnType<typeof setup>, index: number) =>
  s.starts[index]?.inputs.find((i) => i.name === 'brief')?.text ?? '';

describe('references in a start request (CR-016)', () => {
  it('[TC-IMAGE-001-H] [TC-IMAGE-001-N] image references require ownership and model support, and only private history contains their body', async () => {
    const image = {
      kind: 'image_attachment' as const,
      imageId: 'image_fixture',
      name: 'private.png',
      mime: 'image/png' as const,
      bytes: 3,
      sha256: 'a'.repeat(64),
      width: 1,
      height: 1,
    };
    let supported = false;
    const starts: AgentStartInput[] = [];
    const store = new InMemoryRunStore();
    const coordinator = new Coordinator({
      store,
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      images: {
        read: (sessionId, ref) =>
          sessionId === 'session_1' && ref.sha256 === image.sha256
            ? { ...ref, data: 'AQID' }
            : null,
      },
      models: {
        resolve: (profile) => ({
          ok: true,
          snapshot: { profile, provider: null, modelId: null, auth: 'mock', imageInput: supported },
        }),
      },
      agents: new ScriptedAgentAdapter({
        turns: 1,
        beforeReply: async (_turn, input) => {
          starts.push(input);
        },
      }),
    });
    const request = {
      schemaVersion: '0.1' as const,
      commandId: 'no_image_model',
      definition: linearCorral(['writer']),
      mode: 'mock' as const,
      sessionId: 'session_1',
      references: [image],
    };
    expect(coordinator.startRun(request).receipt.error?.code).toBe('CAPABILITY_DENIED');
    supported = true;
    expect(
      coordinator.startRun({ ...request, commandId: 'foreign_image', sessionId: 'other_session' })
        .runId,
    ).toBeNull();
    const started = coordinator.startRun({ ...request, commandId: 'image_supported' });
    expect(started.runId).toBeTruthy();
    await waitForProjection(
      new InProcessTransport(coordinator),
      started.runId!,
      (p) => p.status === 'succeeded',
    );
    expect(starts[0]?.images).toEqual([{ ...image, data: 'AQID' }]);
    expect(starts[0]?.role.allowedWorkTools).toEqual(request.definition.roles[0]?.allowedWorkTools);
    expect(JSON.stringify(exportRunArchive(store, started.runId!))).not.toMatch(
      /AQID|private\.png/,
    );
    const archived = openRunArchive(
      exportRunArchive(store, started.runId!, { privateTranscript: true }),
    );
    expect(archived.visibility).toBe('private');
    if (archived.visibility === 'private')
      expect(archived.artifacts[image.imageId]).toContain('AQID');
  });
  it('[TC-REF-001-H] lists files, folders, runs and roles as pointers after the brief', async () => {
    const s = setup();
    const first = await run(s, 'cmd_first');
    const runA = first.result.runId ?? '';
    const roleId = first.definition.roles[0]?.id ?? '';
    const second = await run(s, 'cmd_second', [
      { kind: 'file', path: 'src/app.ts', lines: { start: 3, end: 9 } },
      { kind: 'folder', path: 'docs' },
      { kind: 'run', runId: runA },
      { kind: 'role', roleId },
    ]);
    expect(second.result.receipt.status).toBe('applied');
    const text = brief(s, 1);
    expect(text.startsWith(first.definition.input.brief)).toBe(true);
    expect(text).toContain('References');
    expect(text).toContain('src/app.ts (lines 3-9)');
    expect(text).toContain('docs/');
    expect(text).toContain(runA);
    expect(text).toContain(roleId);
    // Pointers only: nothing in the agent's input carries a file's text or a new tool.
    expect(text).toContain('do not grant access');
  });

  it('[TC-REF-002-H] copies a referenced result at the chosen version', async () => {
    const s = setup();
    const first = await run(s, 'cmd_first');
    const runA = first.result.runId ?? '';
    const versionId = first.projection?.output?.artifactVersionIds[0] ?? '';
    const body = s.coordinator.getArtifactText(runA, versionId) ?? '';
    await run(s, 'cmd_second', [{ kind: 'result', runId: runA, artifactVersionId: versionId }]);
    expect(brief(s, 1)).toContain(body);
    expect(s.starts[1]?.inputs.every((i) => i.artifactVersionId !== versionId)).toBe(true);
  });

  it('[TC-REF-003-F] refuses a result, run or role that does not exist, and starts nothing', async () => {
    const s = setup();
    for (const [id, reference] of [
      ['cmd_a', { kind: 'result', runId: 'run_nope', artifactVersionId: 'av_nope' }],
      ['cmd_b', { kind: 'run', runId: 'run_nope' }],
      ['cmd_c', { kind: 'role', roleId: 'role_nope' }],
    ] as const) {
      const result = await run(s, id, [reference as RunReference]);
      expect(result.result.runId).toBeNull();
      expect(result.result.receipt.error?.code).toBe('TARGET_NOT_FOUND');
    }
    expect(s.coordinator.listRuns()).toEqual([]);
  });

  it('[TC-REF-004-F] refuses results larger than the artifact cap together', async () => {
    const s = setup(64);
    const first = await run(s, 'cmd_first');
    const runA = first.result.runId ?? '';
    const versionId = first.projection?.output?.artifactVersionIds[0] ?? '';
    const ref = { kind: 'result', runId: runA, artifactVersionId: versionId } as const;
    // One fits; four of the same text do not, and the request is refused rather than cut.
    const many = await run(s, 'cmd_many', [ref, ref, ref, ref]);
    expect(many.result.runId).toBeNull();
    expect(many.result.receipt.error?.code).toBe('LIMIT_REACHED');
  });

  it('[TC-REF-005-F] the request schema rejects absolute or escaping paths and too many references', () => {
    const base = {
      schemaVersion: '0.1',
      commandId: 'cmd_x',
      definition: linearCorral(['writer']),
      mode: 'mock',
    };
    for (const path of ['/etc/passwd', '../secret', 'a/../../b', 'C:\\x']) {
      expect(
        StartRunRequest.safeParse({ ...base, references: [{ kind: 'file', path }] }).success,
      ).toBe(false);
    }
    const twentyOne = Array.from({ length: 21 }, (_, i) => ({ kind: 'file', path: `f${i}` }));
    expect(StartRunRequest.safeParse({ ...base, references: twentyOne }).success).toBe(false);
    expect(
      StartRunRequest.safeParse({
        ...base,
        references: [{ kind: 'file', path: 'a.ts', lines: { start: 5, end: 2 } }],
      }).success,
    ).toBe(false);
  });

  it('[TC-REF-006-D] the same command with the same references returns the first receipt', async () => {
    const s = setup();
    const refs: RunReference[] = [{ kind: 'folder', path: 'docs' }];
    const a = await run(s, 'cmd_same', refs);
    const b = s.coordinator.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_same',
      definition: a.definition,
      mode: 'mock',
      references: refs,
    });
    expect(b.runId).toBe(a.result.runId);
    expect(s.coordinator.listRuns()).toHaveLength(1);
  });
});

it('[TC-CHAT-001-H] [TC-CHAT-001-N] text attachments are immutable private input, never file permission, and invalid bodies do not start', async () => {
  const text = 'Private attachment 한국어';
  const attachment = {
    kind: 'text_attachment' as const,
    name: 'notes.md',
    mime: 'text/markdown' as const,
    bytes: 28,
    sha256: 'c4ce4971cceb0ca9b36537379b41e4cc64e6f638776d94eb0791c76460fd90b8',
    text,
  };
  const s = setup();
  const valid = await run(s, 'with_text', [attachment]);
  expect(valid.result.receipt.status).toBe('applied');
  expect(brief(s, 0)).toContain(text);
  expect(brief(s, 0)).toContain('source data');
  expect(s.starts[0]?.role.allowedWorkTools).not.toContain('read_file');
  expect(JSON.stringify(s.coordinator.getSnapshot(valid.result.runId!).projection)).not.toContain(
    text,
  );
  for (const [index, refs] of [
    [{ ...attachment, text: 'changed' }],
    [{ ...attachment, bytes: 1 }],
    [{ ...attachment, name: '../secret.md' }],
    [{ ...attachment, mime: 'image/png' }],
    [{ ...attachment, text: 'x'.repeat(65537) }],
    Array.from({ length: 6 }, (_, n) => ({ ...attachment, name: `${n}.md` })),
  ].entries()) {
    expect((await run(s, `invalid_text_${index}`, refs as RunReference[])).result.runId).toBeNull();
  }
  expect(s.coordinator.listRuns()).toHaveLength(1);
});

it('[TC-WBD-007-H] [TC-WBD-007-N] captures source metadata in private input and keeps identical text from different sources distinct', async () => {
  const source = {
    kind: 'code' as const,
    target: {
      hostId: 'host',
      projectId: 'project',
      bindingId: 'binding',
      sessionId: 'session',
      copyGeneration: 1,
    },
    path: 'src/a.ts',
    snapshot: 'draft' as const,
    baseHash: 'a'.repeat(64),
    bufferHash: 'b'.repeat(64),
    editVersion: 2,
    range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 },
  };
  const plain = createTextAttachment('selection.txt', 'text/plain', 'one');
  const attachments = [
    createTextAttachment('selection.txt', 'text/plain', 'one', source),
    { ...plain, provenance: { ...source, path: 'src/b.ts' } },
  ];
  const s = setup();
  const started = await run(s, 'captured_sources', attachments);
  expect(started.result.receipt.status).toBe('applied');
  expect(brief(s, 0)).toContain('Captured snapshot');
  expect(brief(s, 0)).toContain('user-supplied provenance');
  expect(brief(s, 0)).toContain('src/a.ts');
  expect(brief(s, 0)).toContain('src/b.ts');
  expect(brief(s, 0)).toContain('"snapshot":"draft"');
  expect(brief(s, 0)).toContain('"copyGeneration":1');
  expect(s.starts[0]?.role.allowedWorkTools).not.toContain('read_file');
  expect((await run(s, 'captured_sources', attachments)).result.runId).toBe(started.result.runId);
  const changed = [{ ...attachments[0], provenance: { ...source, editVersion: 3 } }];
  expect(
    (await run(s, 'captured_sources', changed as RunReference[])).result.receipt.error?.code,
  ).toBe('IDEMPOTENCY_CONFLICT');
  for (const [index, reference] of [
    { ...attachments[0], text: 'changed after hashing' },
    { ...plain, provenance: { ...source, path: '../outside.ts' } },
    {
      ...plain,
      provenance: { ...source, range: { startLine: 2, startColumn: 1, endLine: 1, endColumn: 4 } },
    },
  ].entries())
    expect(
      (await run(s, `invalid_source_${index}`, [reference] as RunReference[])).result.runId,
    ).toBeNull();
});
