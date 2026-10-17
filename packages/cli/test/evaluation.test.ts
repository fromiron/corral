import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator, InProcessTransport } from '@corral/core';
import {
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import { loadSuite, runSuite } from '../src/exec.ts';

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
