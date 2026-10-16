import type { AgentStartInput } from '@corral/contracts';
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

// CR-007: a new Run starts from a version of an earlier Run. The text is copied into the new
// Run's brief; the new Run never refers to the old one's versions; run.started says where from.

function setup(maxArtifactBytes = SPEC_HARD_CAPS.maxArtifactBytes, store = new InMemoryRunStore()) {
  const starts: AgentStartInput[] = [];
  const coordinator = new Coordinator({
    store,
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    policy: { ...SPEC_HARD_CAPS, maxArtifactBytes },
    agents: new ScriptedAgentAdapter({
      turns: 1,
      reply: (_turn, input) => `Draft from ${input.nodeId}: ${input.inputs[0]?.text ?? ''}`,
      beforeReply: async (turn, input) => {
        if (turn === 1) starts.push(JSON.parse(JSON.stringify(input)) as AgentStartInput);
      },
    }),
  });
  return { coordinator, transport: new InProcessTransport(coordinator), starts, store };
}

async function finishedRun(
  s: ReturnType<typeof setup>,
  commandId: string,
  startFrom?: { runId: string; artifactVersionId: string },
) {
  const result = s.coordinator.startRun({
    schemaVersion: '0.1',
    commandId,
    definition: linearCorral(['writer']),
    mode: 'mock',
    ...(startFrom ? { startFrom } : {}),
  });
  if (!result.runId) return { result, projection: null };
  const projection = await waitForProjection(s.transport, result.runId, (p) =>
    ['succeeded', 'failed', 'cancelled'].includes(p.status),
  );
  return { result, projection };
}

describe('a new Run from an earlier version (CR-007)', () => {
  it('[TC-ART-005-H] copies the version text into the new brief and records where it came from', async () => {
    const s = setup();
    const first = await finishedRun(s, 'cmd_first');
    const runA = first.result.runId ?? '';
    const versionId = first.projection?.output?.artifactVersionIds[0] ?? '';
    const text = s.coordinator.getArtifactText(runA, versionId) ?? '';
    expect(text).toContain('Draft from writer');
    const eventsBefore = s.coordinator.getSnapshot(runA).seq;

    const second = await finishedRun(s, 'cmd_second', {
      runId: runA,
      artifactVersionId: versionId,
    });
    expect(second.result.receipt.status).toBe('applied');
    expect(second.projection?.status).toBe('succeeded');
    expect(second.projection?.startedFrom).toEqual({ runId: runA, artifactVersionId: versionId });
    const brief = s.starts[1]?.inputs.find((i) => i.name === 'brief')?.text ?? '';
    expect(brief.startsWith(linearCorral(['writer']).input.brief)).toBe(true);
    expect(brief).toContain('Start from this earlier version');
    expect(brief).toContain(text);
    // Nothing in the new run points into the old one, and the old run is untouched.
    expect(s.starts[1]?.inputs.every((i) => i.artifactVersionId !== versionId)).toBe(true);
    expect(s.coordinator.getSnapshot(runA).seq).toBe(eventsBefore);
  });

  it('[TC-ART-005-N] refuses an unknown run, a version of another run and an oversized text, and starts nothing', async () => {
    const s = setup();
    const a = await finishedRun(s, 'cmd_a');
    const b = await finishedRun(s, 'cmd_b');
    const runA = a.result.runId ?? '';
    const versionOfB = b.projection?.output?.artifactVersionIds[0] ?? '';
    const runs = s.coordinator.listRuns().length;
    for (const [commandId, startFrom] of [
      ['cmd_unknown', { runId: 'run_nope', artifactVersionId: versionOfB }],
      ['cmd_other', { runId: runA, artifactVersionId: versionOfB }],
    ] as const) {
      const { result } = await finishedRun(s, commandId, startFrom);
      expect(result.runId).toBeNull();
      expect(result.receipt.error?.code).toBe('TARGET_NOT_FOUND');
    }
    expect(s.coordinator.listRuns()).toHaveLength(runs);

    // The version was written under the old cap; this installation's cap is now lower.
    const recorded = setup();
    const c = await finishedRun(recorded, 'cmd_c');
    const small = setup(40, recorded.store);
    const big = await finishedRun(small, 'cmd_big', {
      runId: c.result.runId ?? '',
      artifactVersionId: c.projection?.output?.artifactVersionIds[0] ?? '',
    });
    expect(big.result.runId).toBeNull();
    expect(big.result.receipt.error?.code).toBe('LIMIT_REACHED');
  });
});
