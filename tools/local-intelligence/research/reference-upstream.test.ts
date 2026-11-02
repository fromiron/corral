import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as adapter from './reference-upstream.ts';
import {
  loadPinnedUpstream,
  prepareRecord,
  prepareReference,
  referenceInput,
} from './reference-upstream.ts';

const synthetic = () => ({
  task: 'effort' as const,
  split: 'policy',
  input: {
    goal: 'Fix the parser',
    request: 'Continue',
    previousRequest: 'Inspect it',
    previousReply: 'Earlier reply',
    stage: 'step',
    plan: 'Read source',
    tools: [
      { name: 'read_file', args: 'src/a.ts', status: 'completed', content: 'Observed source' },
    ],
  },
});

test('synthetic steps use goal+request and explicitly assume step1 without reading labels', () => {
  const row = synthetic();
  const before = structuredClone(row);
  for (const key of ['target', 'verifier', 'expectedDifficulty', 'workerAnswers'])
    Object.defineProperty(row, key, {
      get() {
        throw new Error('hidden label read');
      },
    });
  const derived = referenceInput(row);
  assert.equal(derived.stepNumberSource, 'assumed-one');
  assert.deepEqual(derived.value.step, {
    request: 'Fix the parser\nContinue',
    step: 1,
    plan: 'Read source',
    calls: [{ name: 'read_file', args: 'src/a.ts', result: 'Observed source' }],
  });
  assert.deepEqual(row, before);
});

test('actual Core copy is authoritative over raw inputs and preserves the actual step', () => {
  const coreReasoningInput = {
    kind: 'step' as const,
    request: 'Core request',
    prevRequest: '',
    prev: '',
    step: 4,
    plan: '',
    calls: [
      {
        name: 'read_file',
        args: '{"path":"a"}',
        result: 'Core window',
        status: 'completed' as const,
      },
    ],
    directiveIds: [],
  };
  const row = { task: 'effort' as const, split: 'policy', coreReasoningInput };
  Object.defineProperty(row, 'input', {
    get() {
      throw new Error('raw input read');
    },
  });
  const before = structuredClone(coreReasoningInput);
  const result = referenceInput(row);
  assert.equal(result.view, 'coreReasoningInput');
  assert.equal(result.stepNumberSource, 'core');
  assert.equal(result.value.step?.step, 4);
  assert.equal(result.value.step?.calls[0]?.result, 'Core window');
  assert.deepEqual(coreReasoningInput, before);
});

test('turns preserve previous reply and final/compaction inputs are refused', () => {
  const row = synthetic();
  row.input.stage = 'turn';
  const result = referenceInput(row);
  assert.equal(result.value.request, 'Fix the parser\nContinue');
  assert.equal(result.value.prev, 'Earlier reply');
  assert.equal(result.value.step, undefined);
  assert.throws(() => referenceInput({ ...row, split: 'final' }));
  row.input.stage = 'compaction';
  assert.throws(() => referenceInput(row));
});

test('explicit final unseal retains the real split and unchanged formatter input', () => {
  const policy = synthetic();
  const final = { ...policy, split: 'final' };
  assert.throws(() => referenceInput(final));
  assert.deepEqual(referenceInput(final, true), referenceInput(policy));
  assert.equal(final.split, 'final');
});

test('final exposure is explicit, private, immutable, and recorded before preparation', () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-reference-exposure-'));
  try {
    const output = join(root, 'ids.json');
    const identity = { inputSha256: 'frozen-input', sourceSha256: 'execution-wrapper' };
    assert.throws(() => adapter.recordFinalExposure([{ split: 'final' }], output, false, identity));
    assert.equal(existsSync(`${output}.exposure.json`), false);
    assert.equal(adapter.recordFinalExposure([{ split: 'final' }], output, true, identity), true);
    const exposure = JSON.parse(readFileSync(`${output}.exposure.json`, 'utf8'));
    assert.equal(exposure.unsealFinal, true);
    assert.equal(exposure.inputSha256, identity.inputSha256);
    assert.equal(statSync(`${output}.exposure.json`).mode & 0o777, 0o600);
    assert.throws(() => adapter.recordFinalExposure([{ split: 'final' }], output, true, identity));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preparation delegates IDs to upstream and does not infer a confidence or label', () => {
  const row = { ...synthetic(), id: 'p1', group: 'g1' };
  const calls: unknown[] = [];
  const runtime = {
    tokenizer: { prefix: [2], suffix: [1], encode: () => [77] },
    inputIds: (_t: unknown, format: string, limit: number, input: unknown) => {
      calls.push({ format, limit, input });
      return [2, 77, 1];
    },
    judgeText: () => 'turn text',
    stepJudgeText: () => 'step text',
  };
  const prepared = prepareRecord(row, runtime);
  assert.deepEqual(prepared.tokenIds, [2, 77, 1]);
  assert.equal(prepared.formattedText, 'step text');
  assert.equal(calls.length, 1);
  assert.equal('target' in prepared, false);
  assert.equal('probabilities' in prepared, false);
});

test('pinned-source load rejects a different blob before evaluating it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-reference-pin-'));
  try {
    mkdirSync(join(root, 'src/runtime/effort-judge'), { recursive: true });
    writeFileSync(
      join(root, 'src/runtime/effort-judge/judge-input.mjs'),
      'throw new Error("must never execute");',
    );
    await assert.rejects(loadPinnedUpstream(root), /source blob differs from pin/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tokenizer cache cannot be placed in the original asset directory', async () => {
  const assets = mkdtempSync(join(tmpdir(), 'corral-reference-assets-'));
  try {
    const before = readdirSync(assets);
    await assert.rejects(
      prepareReference({
        upstream: '/unused',
        assets,
        copy: assets,
        input: '/unused',
        out: join(assets, 'out.json'),
      }),
      /outside source assets/,
    );
    assert.deepEqual(readdirSync(assets), before);
  } finally {
    rmSync(assets, { recursive: true, force: true });
  }
});

test('actual pinned worker retains UTF16 rp cuts and actual step cleaner', {
  skip: !process.env.CORRAL_REFERENCE_UPSTREAM,
}, async () => {
  const upstream = await loadPinnedUpstream(process.env.CORRAL_REFERENCE_UPSTREAM ?? '');
  const ids = upstream.inputIds(
    { prefix: [2], suffix: [1], encode: () => Array.from({ length: 300 }, (_, i) => i + 100) },
    'rp',
    256,
    { request: 'test', prev: '', prevRequest: '' },
  );
  assert.equal(ids.length, 256);
  assert.equal(ids[0], 2);
  assert.equal(ids[254], 353);
  assert.equal(ids[255], 1);
  const request = `${'a'.repeat(1499)}😀`;
  const previous = `😀${'z'.repeat(999)}`;
  assert.equal(
    upstream.judgeText('rp', request, previous, ''),
    `request: ${'a'.repeat(1499)}\ud83d\nprevious reply: \ude00${'z'.repeat(999)}`,
  );
  assert.equal(
    upstream.stepJudgeText({ request: 'Fix ```hidden code``` now', step: 3, plan: '', calls: [] }),
    'step 3\nrequest: Fix [code] now',
  );
});
