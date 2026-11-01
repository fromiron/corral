import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  formatDecisionPrompt,
  renderEffort,
  toEffortInput,
} from '../../../packages/local-intelligence/src/decision/text.ts';
import { effortText } from '../../../packages/local-intelligence/src/effort/preprocess.ts';
import { deriveOutcomeRuntime, writeOutcomeRuntime } from './outcome-runtime.ts';

function row() {
  return {
    id: 'case-development',
    group: 'case-family',
    task: 'effort' as const,
    target: null,
    input: {
      request: 'Inspect the source and fix the bug.',
      stage: 'step',
      goal: '',
      previousRequest: '',
      previousReply: '',
      plan: '',
      tools: [
        {
          name: 'read_file',
          args: 'src/a"b.ts',
          status: 'success',
          content: 'Error: this is successful source-file text.',
        },
      ],
    },
  };
}

test('real Core normalizes read arguments and completed status without invented previous reply', () => {
  const source = row();
  const before = structuredClone(source);
  const derived = deriveOutcomeRuntime(source);
  assert.deepEqual(derived.coreReasoningInput, {
    kind: 'step',
    request: source.input.request,
    prevRequest: '',
    prev: '',
    step: 1,
    plan: '',
    directiveIds: [],
    calls: [
      {
        name: 'read_file',
        args: '{"path":"src/a\\"b.ts"}',
        status: 'completed',
        result: source.input.tools[0]?.content,
      },
    ],
  });
  assert.equal(
    derived.runtimeView.runtimeText,
    renderEffort(toEffortInput(derived.coreReasoningInput)),
  );
  assert.equal(derived.runtimeView.legacyText, effortText(derived.coreReasoningInput));
  assert.equal(
    derived.runtimeView.prompt,
    formatDecisionPrompt('effort', renderEffort(toEffortInput(derived.coreReasoningInput))),
  );
  assert.match(derived.runtimeView.prompt, /status: completed/);
  assert.doesNotMatch(derived.runtimeView.prompt, /Previous (reply|user request):/);
  assert.equal(derived.runtimeView.scope, 'modeled-completed-read-snapshot');
  assert.deepEqual(source, before);
});

test('actual Core owns the 3000-code-point result window, request window and three-call limit', () => {
  const source = row();
  source.input.request = '😀'.repeat(12001);
  source.input.tools = Array.from({ length: 4 }, (_, i) => ({
    name: 'read_file',
    args: `file-${i}`,
    status: 'success',
    content: '😀'.repeat(2000) + 'MIDDLE_REMOVED'.repeat(100) + '終'.repeat(1000),
  }));
  const input = deriveOutcomeRuntime(source).coreReasoningInput;
  assert.equal(Array.from(input.request).length, 12000);
  assert.equal(input.calls.length, 3);
  const first = input.calls[0];
  const tool = source.input.tools[0];
  assert.ok(first && tool);
  assert.equal(first.result, `${'😀'.repeat(2000)}\n…\n${'終'.repeat(1000)}`);
  assert.equal(Array.from(first.result).length, 3003);
  tool.content = 'x'.repeat(3000);
  assert.equal(deriveOutcomeRuntime(source).coreReasoningInput.calls[0]?.result, 'x'.repeat(3000));
});

test('target and worker metadata are opaque to the renderer', () => {
  const source = row();
  for (const key of [
    'target',
    'id',
    'group',
    'workerAnswers',
    'tests',
    'reference',
    'expectedDifficulty',
  ]) {
    Object.defineProperty(source, key, {
      get() {
        throw new Error('private metadata read');
      },
      enumerable: true,
    });
  }
  assert.doesNotThrow(() => deriveOutcomeRuntime(source));
});

test('unsupported nonempty input fields and non-completed reads are rejected', () => {
  for (const key of ['goal', 'previousRequest', 'previousReply', 'plan']) {
    assert.throws(() =>
      deriveOutcomeRuntime({
        ...row(),
        input: { ...row().input, [key]: 'unsupported supplied value' },
      }),
    );
  }
  const unknown = { ...row(), input: { ...row().input, unknown: 'must not silently drop' } };
  assert.throws(() => deriveOutcomeRuntime(unknown));
  const source = row();
  const tool = source.input.tools[0];
  assert.ok(tool);
  tool.status = 'failed';
  assert.throws(() => deriveOutcomeRuntime(source));
  tool.status = 'success';
  tool.name = 'run_command';
  assert.throws(() => deriveOutcomeRuntime(source));
});

test('private writer preserves original row-field bytes, null target, and source; no overwrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'corral-outcome-runtime-'));
  try {
    const source = join(dir, 'raw.jsonl');
    const output = join(dir, 'derived.jsonl');
    const original = ` ${JSON.stringify(row()).replace('Inspect', '\\u0049nspect')} \r\n`;
    writeFileSync(source, original);
    const receipt = writeOutcomeRuntime(source, output);
    const result = readFileSync(output, 'utf8');
    const at = original.lastIndexOf('}');
    assert.equal(result.slice(0, at), original.slice(0, at));
    assert.equal(result.slice(-4), original.slice(-4));
    const parsed = JSON.parse(result);
    assert.equal(parsed.target, null);
    assert.deepEqual(parsed.input, row().input);
    assert.equal(parsed.id, row().id);
    assert.equal(parsed.group, row().group);
    assert.equal(readFileSync(source, 'utf8'), original);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(receipt.rowCount, 1);
    assert.equal(receipt.exactV2PromptMatchCount, 0);
    assert.throws(() => writeOutcomeRuntime(source, output));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI only produces a modeled-input receipt and rejects repository data paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'corral-outcome-cli-'));
  try {
    const source = join(dir, 'raw.jsonl');
    const output = join(dir, 'view.jsonl');
    writeFileSync(source, `${JSON.stringify(row())}\n`);
    const process = spawnSync(
      globalThis.process.execPath,
      [fileURLToPath(new URL('./outcome-runtime.ts', import.meta.url)), source, output],
      { encoding: 'utf8' },
    );
    assert.equal(process.status, 0, process.stderr);
    const receipt = JSON.parse(process.stdout);
    assert.equal(receipt.scope, 'modeled-completed-read-snapshot');
    assert.equal(receipt.rowCount, 1);
    assert.doesNotMatch(process.stdout, /prediction|score|confidence|Inspect/);
    assert.throws(() =>
      writeOutcomeRuntime(source, fileURLToPath(new URL('./private.jsonl', import.meta.url))),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explicit v2 comparison uses stored text and requires the same case IDs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'corral-outcome-comparison-'));
  try {
    const source = join(dir, 'raw.jsonl');
    const baseline = join(dir, 'v2.jsonl');
    const output = join(dir, 'new.jsonl');
    const item = row();
    writeFileSync(source, `${JSON.stringify(item)}\n`);
    writeFileSync(
      baseline,
      `${JSON.stringify({ id: item.id, task: item.task, text: deriveOutcomeRuntime(item).runtimeView.runtimeText })}\n`,
    );
    assert.equal(writeOutcomeRuntime(source, output, baseline).exactV2PromptMatchCount, 1);
    writeFileSync(
      baseline,
      `${JSON.stringify({ id: 'different-case', task: item.task, text: 'same shape, wrong case' })}\n`,
    );
    assert.throws(() => writeOutcomeRuntime(source, join(dir, 'mismatched.jsonl'), baseline));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
