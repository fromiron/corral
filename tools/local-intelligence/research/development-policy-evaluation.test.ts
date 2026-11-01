import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  type DevelopmentManifest,
  type Fixture,
  scoreDecisions,
  separatePolicyData,
  validateManifest,
  validateReceipt,
  validateVisibleInput,
} from './development-policy-evaluation.ts';
import { type DevelopmentCase, evaluateDevelopmentPolicy } from './effort-policies.ts';
import { deriveOutcomeRuntime } from './outcome-runtime.ts';

const root = resolve('/private/research');
function manifest(): DevelopmentManifest {
  const id = 'outcome-0000-00';
  const group = {
    id,
    group: 'audited-family',
    family: 'audited-family',
    phase: 'development',
    origin: 'original',
    version: 0,
    casePath: `outcomes/validated/${id}/case.json`,
    visibleFixturePath: `${root}/outcomes/validated/${id}/case.json`,
    workerRoot: '.',
    availability: { complete: true, receiptCount: 8, expectedReceipts: 8, missing: [] },
    receipts: (['low', 'medium', 'high', 'xhigh'] as const).flatMap((effort) =>
      ([0, 1] as const).map((repeat) => ({
        effort,
        repeat,
        path: `${root}/outcomes/trials-corral/${id}/${effort}/${repeat}/receipt.json`,
      })),
    ),
  };
  return {
    phase: 'development',
    frozen: true,
    frozenAt: '2026-01-01T00:00:00Z',
    workerOutcomesReadBySelector: false,
    finalOutcomeAccessAuthorized: false,
    qualifiedDevelopmentGroups: 1,
    includedCompleteGroups: 1,
    excludedIncompleteGroups: 0,
    groups: [group],
    excludedIncomplete: [],
  };
}

function fixture(): Fixture {
  return {
    id: 'outcome-0000-00',
    group: 'original-source-group',
    request: 'Fix the parser.',
    context: 'Observed failure.',
    files: [{ path: 'src/a.py', content: 'broken' }],
  };
}

test('only frozen development manifests and exact declared receipt paths are allowed', () => {
  const valid = manifest();
  validateManifest(valid, root);
  for (const change of [
    { ...valid, phase: 'final' },
    { ...valid, frozen: false },
    { ...valid, finalOutcomeAccessAuthorized: true },
  ])
    assert.throws(() => validateManifest(change, root));
  const escaped = manifest();
  const first = escaped.groups[0];
  assert.ok(first);
  first.receipts[0] = {
    effort: 'low',
    repeat: 0,
    path: `${root}/outcomes/trials-corral/outcome-0100-00/low/0/receipt.json`,
  };
  assert.throws(() => validateManifest(escaped, root));
});

test('excluded incomplete families need no fabricated included-group alias or receipt access', () => {
  const value = manifest();
  value.qualifiedDevelopmentGroups = 2;
  value.excludedIncompleteGroups = 1;
  value.excludedIncomplete = [
    {
      id: 'outcome-0000-01',
      family: 'excluded-family',
      phase: 'development',
      origin: 'original',
      version: 0,
      availability: {
        complete: false,
        receiptCount: 7,
        expectedReceipts: 8,
        missing: [{ effort: 'low', repeat: 0 }],
      },
    },
  ];
  assert.doesNotThrow(() => validateManifest(value, root));
});

test('receipt source group is checked while audited group remains independent', () => {
  const entry = manifest().groups[0];
  assert.ok(entry);
  const slot = entry.receipts[0];
  assert.ok(slot);
  const receipt = {
    id: entry.id,
    group: 'original-source-group',
    model: 'gpt-6.1-sol',
    role: 'evaluated-worker',
    effort: 'low',
    repeat: 0,
    transport: 'corral',
    fixtureHash: 'fixture-hash',
    promptHash: 'prompt-hash',
    wire: { kind: 'effort', value: 'low' },
    grade: { passed: false },
    usage: { totalTokens: 12 },
    responseSeconds: 1,
  };
  const expected = {
    fixtureHash: 'fixture-hash',
    promptHash: 'prompt-hash',
    inputHash: 'input-hash',
  };
  const complete = validateReceipt(receipt, entry, slot, fixture(), expected);
  assert.equal(complete.trial?.passed, false); // A failed answer is still a complete trial.
  assert.equal(complete.trial?.totalTokens, 12);
  assert.throws(() =>
    validateReceipt(
      { ...receipt, fixtureHash: 'another-version' },
      entry,
      slot,
      fixture(),
      expected,
    ),
  );
  assert.throws(() =>
    validateReceipt(
      { ...receipt, wire: { kind: 'effort', value: 'high' } },
      entry,
      slot,
      fixture(),
      expected,
    ),
  );
  assert.equal(
    validateReceipt({ ...receipt, usage: {} }, entry, slot, fixture(), expected).reason,
    'missing-or-invalid-total-usage',
  );
});

test('CoreV3 visible-input parity never uses hidden reference or tests', () => {
  const data = fixture();
  const input = {
    goal: '',
    request: `${data.request}\nObserved context:\n${data.context}`,
    previousRequest: '',
    previousReply: '',
    stage: 'step',
    plan: '',
    tools: data.files.map((file) => ({
      name: 'read_file',
      args: file.path,
      status: 'success',
      content: file.content,
    })),
  };
  const view = deriveOutcomeRuntime({ task: 'effort', input });
  const source = {
    id: data.id,
    group: data.group,
    task: 'effort',
    split: 'policy',
    target: null,
    source: { kind: 'executable-snapshot' },
    input,
    ...view,
  };
  Object.defineProperty(data, 'tests', {
    get() {
      throw new Error('hidden tests read');
    },
  });
  Object.defineProperty(data, 'referenceFiles', {
    get() {
      throw new Error('hidden reference read');
    },
  });
  assert.doesNotThrow(() => validateVisibleInput(source, data));
  assert.throws(() => validateVisibleInput(source, { ...fixture(), request: 'Different input' }));
});

test('external applied-policy scoring matches frozen group-weighted helper metrics', () => {
  const cases: DevelopmentCase[] = Array.from({ length: 3 }, (_, index) => ({
    id: String(index),
    group: index < 2 ? 'a' : 'b',
    split: 'development',
    probabilities: [1, 0, 0, 0],
    trials: (['low', 'medium', 'high', 'xhigh'] as const).flatMap((level, levelIndex) =>
      ([0, 1] as const).map((repeat) => ({
        level,
        repeat,
        completed: true,
        passed: index < 2 || level !== 'low',
        totalTokens: 10 * (levelIndex + 1),
      })),
    ),
  }));
  const evaluated = evaluateDevelopmentPolicy(cases, { kind: 'identity' });
  const applied = new Map(cases.map((item) => [item.id, 'low' as const]));
  const result = scoreDecisions(cases, applied);
  assert.equal(result.successRate, evaluated.metrics.successRate);
  assert.equal(result.meanTotalTokens, evaluated.metrics.meanTotalTokens);
  assert.equal(result.totalTokens, evaluated.metrics.totalTokens);
});

test('export separates observed outcomes from actual classifier policy inputs', () => {
  const item: DevelopmentCase = {
    id: 'case',
    group: 'family',
    split: 'development',
    probabilities: [0.1, 0.2, 0.6, 0.1],
    trials: [],
  };
  const result = separatePolicyData([item]);
  const input = result.policyInputs[0];
  const outcome = result.outcomeCases[0];
  assert.ok(input && outcome);
  assert.deepEqual(input.probabilities, item.probabilities);
  assert.equal(Object.hasOwn(outcome, 'probabilities'), false);
  assert.equal(Object.hasOwn(input, 'trials'), false);
});
