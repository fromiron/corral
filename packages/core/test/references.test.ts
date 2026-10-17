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
  InMemoryRunStore,
  InProcessTransport,
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
