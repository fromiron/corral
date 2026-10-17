import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorralDefinition } from '@corral/contracts';
import { Coordinator, InProcessTransport, reviewCriteriaHash } from '@corral/core';
import {
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import reviewTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import { executeOnce, loadSuite, runSuite } from '../src/exec.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const runtime = () =>
  new InProcessTransport(
    new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({
        turns: 1,
        appendNotes: false,
        reply: () => '{"answer":42}',
      }),
    }),
  );
it('[TC-HAR-014-H] prepares a fresh pinned work session for each comparison case',async()=>{
  const transport=runtime();let prepared=0;
  const suite={workspace:{projectId:'default',baseCommit:'a'.repeat(40)},briefs:[{id:'one',brief:'First'},{id:'two',brief:'Second'}],variants:[{id:'base',corral:'base.json',definition:linearCorral(['writer'])}]};
  const report=await runSuite(transport,suite,'mock',{signal:new AbortController().signal,prepareWorkspace:async target=>({sessionId:`session_${++prepared}`,baseCommit:target.baseCommit})});
  expect(prepared).toBe(2);
  expect(report.results.map(row=>row.workspace)).toEqual([{sessionId:'session_1',baseCommit:'a'.repeat(40)},{sessionId:'session_2',baseCommit:'a'.repeat(40)}]);
  expect((await transport.listRuns()).map(run=>run.sessionId).sort()).toEqual(['session_1','session_2']);
  await expect(runSuite(runtime(),suite,'mock',{signal:new AbortController().signal})).rejects.toThrow(/workspace/i);
});
it('[TC-HAR-014-H] counts a correct candidate rejected by a recipe and records the repair lineage', async () => {
  const definition = CorralDefinition.parse(reviewTeam),
    loop = definition.nodes.find((node) => node.type === 'loop');
  if (!loop) throw new Error('missing loop');
  loop.reviewRecipe = {
    recipeId: 'eval-review',
    revision: 1,
    criteriaHash: reviewCriteriaHash(definition.input.criteria),
    candidateNodeId: 'write',
    evaluatorRoleId: 'reviewer',
    criteriaFiles: [],
    checkIds: [],
    maxAttempts: 1,
    maxRepairs: 0,
    maxWallMs: 10000,
    maxModelCalls: 20,
    maxOutputTokens: 20000,
  };
  const report = await runSuite(
    runtime(),
    {
      briefs: [{ id: 'one', brief: 'Answer', expected: { kind: 'json', value: { answer: 42 } } }],
      variants: [{ id: 'review', group: 'review_repair', corral: 'review.json', definition }],
    },
    'mock',
    { signal: new AbortController().signal },
  );
  expect(report.results[0]).toMatchObject({
    status: 'failed',
    repairRounds: 0,
    quality: { finalCorrect: false, candidateCorrect: true, unnecessaryRejection: true },
  });
  expect(report.results[0]?.recipeHashes).toHaveLength(1);
});
it('[TC-HAR-014-H] counts committed SDK retry purposes once when the event stream replays frames', async () => {
  const definition = linearCorral(['writer']);
  definition.roles[0]!.harness = { profileId: 'sample', revision: 1 };
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    harnesses: {
      resolve: () => ({
        binding: { profileId: 'sample', revision: 1 },
        snapshotHash: 'a'.repeat(64),
        piVersion: '1.3.0',
        policyRevision: 1,
        policy: 'strict',
        resources: [],
        allowedTools: ['write_artifact', 'submit_result'],
        tools: [],
        diagnostics: [],
      }),
    },
    agents: {
      start: async (input, host) => {
        const done = (async () => {
          await host.reportHarness!({
            ok: true,
            snapshotHash: input.harness!.snapshotHash,
            diagnostics: [],
            tools: ['write_artifact', 'submit_result'].map((name) => ({
              source: 'corral',
              name,
              schemaHash: 'b'.repeat(64),
              exposure: 'direct',
              sideEffect: 'none',
            })),
          });
          for (const purpose of ['turn', 'retry'] as const) {
            const permit = await host.prepareModelRequest({
              purpose,
              directiveIds: [],
              contextHash: 'c'.repeat(64),
              contextBytes: 10,
              sections: [],
            });
            await host.observe({
              kind: 'model_completed',
              modelCallId: permit.modelCallId,
              text: '42',
              usage: { inputTokens: 1, outputTokens: 1 },
            });
          }
          const written = await host.invokeTool({ name: 'write_artifact', args: { text: '42' } });
          if (!written.ok) throw new Error('write failed');
          await host.invokeTool({
            name: 'submit_result',
            args: { artifactVersionIds: [written.result.artifactVersionId] },
          });
          return { outcome: 'succeeded' as const };
        })();
        return { cancel: async () => {}, waitForSettlement: () => done };
      },
    },
  });
  const transport = new InProcessTransport(coordinator),
    subscribe = transport.subscribe.bind(transport);
  transport.subscribe = (id, after, handlers) =>
    subscribe(id, after, {
      ...handlers,
      onEvent: (event) => {
        handlers.onEvent(event);
        handlers.onEvent(event);
      },
    });
  const result = await executeOnce(transport, definition, 'mock', {
    signal: new AbortController().signal,
  });
  expect(result).toMatchObject({
    status: 'succeeded',
    modelCalls: 2,
    modelRetries: 1,
    metricsComplete: true,
    harnessHashes: ['a'.repeat(64)],
  });
  expect(result.toolsExecuted.sort()).toEqual(['submit_result', 'write_artifact']);
});
it('[TC-HAR-014-H] scores fixed expectations separately from run success and keeps calibration out of holdout metrics', async () => {
  const report = await runSuite(
    runtime(),
    {
      briefs: [
        {
          id: 'right',
          brief: 'Answer',
          phase: 'holdout',
          expected: { kind: 'json', value: { answer: 42 } },
        },
        {
          id: 'wrong',
          brief: 'Different answer',
          phase: 'holdout',
          expected: { kind: 'exact', text: 'wrong' },
        },
        {
          id: 'calibrate',
          brief: 'Calibrate',
          phase: 'calibration',
          expected: { kind: 'includes', all: ['42'] },
        },
        { id: 'no-oracle', brief: 'Unscored' },
      ],
      variants: [
        {
          id: 'base',
          group: 'baseline',
          corral: 'base.json',
          definition: linearCorral(['writer']),
        },
      ],
    },
    'mock',
    { signal: new AbortController().signal },
  );
  expect(report.results[0]?.quality).toMatchObject({
    finalCorrect: true,
    candidateCorrect: true,
    falsePass: false,
    unnecessaryRejection: false,
  });
  expect(report.results[1]?.quality).toMatchObject({ finalCorrect: false, falsePass: true });
  expect(report.results[3]?.quality).toBeNull();
  expect(report.summary).toContainEqual(
    expect.objectContaining({
      variant: 'base',
      phase: 'holdout',
      quality: {
        expectedRuns: 2,
        finalCorrect: 1,
        finalAccuracy: 0.5,
        falsePasses: 1,
        unnecessaryRejections: 0,
      },
    }),
  );
  expect(report.summary).toContainEqual(
    expect.objectContaining({
      variant: 'base',
      phase: 'calibration',
      quality: {
        expectedRuns: 1,
        finalCorrect: 1,
        finalAccuracy: 1,
        falsePasses: 0,
        unnecessaryRejections: 0,
      },
    }),
  );
  expect(report.results[0]).toMatchObject({
    modelRetries: 0,
    executionRestarts: 0,
    repairRounds: 0,
    humanRequests: 0,
    definitionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
});
it('[TC-HAR-014-N] a missing oracle is not perfect accuracy and required approval is not a quality rejection', async () => {
  const definition = linearCorral(['writer']);
  const output = definition.nodes.find((node) => node.type === 'output');
  if (output?.type === 'output') output.requireApproval = true;
  const report = await runSuite(
    runtime(),
    {
      briefs: [{ id: 'one', brief: 'Answer', expected: { kind: 'json', value: { answer: 42 } } }],
      variants: [{ id: 'approval', corral: 'a.json', definition }],
    },
    'mock',
    { signal: new AbortController().signal },
  );
  expect(report.results[0]).toMatchObject({
    needsUser: true,
    humanRequests: 1,
    quality: { finalCorrect: false, candidateCorrect: true, unnecessaryRejection: null },
  });
  const unscored = await runSuite(
    runtime(),
    {
      briefs: [{ id: 'one', brief: 'Answer' }],
      variants: [{ id: 'base', corral: 'a.json', definition: linearCorral(['writer']) }],
    },
    'mock',
    { signal: new AbortController().signal },
  );
  expect(unscored.summary[0]?.quality.finalAccuracy).toBeNull();
});
it('[TC-HAR-014-N] validates the five comparison groups and expectations before running any variant', () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-eval-quality-'));
  roots.push(root);
  writeFileSync(join(root, 'base.json'), JSON.stringify(linearCorral(['writer'])));
  const suite = {
    schemaVersion: '0.1',
    comparison: 'personal_harness',
    briefs: [{ id: 'one', brief: 'Answer', expected: { kind: 'json', value: { answer: 42 } } }],
    variants: [
      'baseline',
      'mandatory_skill',
      'deterministic_check',
      'review_repair',
      'coding_tool',
    ].map((group) => ({ id: group, group, corral: 'base.json' })),
  };
  const path = join(root, 'suite.json');
  writeFileSync(path, JSON.stringify(suite));
  const loaded = loadSuite(path);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  expect(loaded.suite.briefs[0]?.expected).toEqual(suite.briefs[0]?.expected);
  expect(loaded.suite.variants.map((variant) => variant.group)).toEqual(
    suite.variants.map((variant) => variant.group),
  );
  writeFileSync(path, JSON.stringify({ ...suite, variants: suite.variants.slice(1) }));
  expect(loadSuite(path).ok).toBe(false);
  writeFileSync(
    path,
    JSON.stringify({
      ...suite,
      briefs: [{ id: 'one', brief: 'Answer', expected: { kind: 'includes', all: [] } }],
    }),
  );
  expect(loadSuite(path).ok).toBe(false);
});
