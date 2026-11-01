import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  formatDecisionPrompt,
  renderMeeting,
} from '../../../packages/local-intelligence/src/decision/text.ts';
import { deriveRuntimeView, restoreRuntimeRecipients, writeRuntimeViews } from './runtime-views.ts';

function scene() {
  return {
    id: 'private-row-id',
    group: 'private-group',
    split: 'final',
    task: 'meeting' as const,
    input: {
      participants: [
        { id: 'alpha', name: 'B', role: 'review' },
        { id: 'a', name: 'A', role: '' },
      ],
      message: 'take a look at alphabet',
      turns: [{ id: 'source-turn-one', speakerId: 'a', text: 'earlier original statement' }],
    },
    target: { mode: 'one', eligibleIds: ['a'], evidence: 'TARGET_SENTINEL' },
  };
}

test('noncanonical roster IDs are compacted in roster order and restored without body rewriting', () => {
  const row = scene();
  const before = structuredClone(row);
  const view = deriveRuntimeView(row);
  assert.deepEqual(view.participantIds, ['p1', 'p2']);
  assert.deepEqual(view.modelToOriginalIds, { p1: 'alpha', p2: 'a' });
  assert.equal(view.historyLimit, 12);
  assert.match(view.prompt, /p1: B; role: review\np2: A/);
  assert.match(view.prompt, /\[t1\] p2: earlier original statement/);
  assert.match(view.prompt, /take a look at alphabet/);
  assert.deepEqual(restoreRuntimeRecipients(view, ['p2', 'p1']), ['a', 'alpha']);
  assert.deepEqual(row, before);
});

test('NONE stays an empty recipient set and invalid aliases cannot become original IDs', () => {
  const view = deriveRuntimeView(scene());
  assert.deepEqual(restoreRuntimeRecipients(view, []), []);
  assert.equal(restoreRuntimeRecipients(view, ['p3']), null);
  assert.equal(restoreRuntimeRecipients(view, ['p1', 'p1']), null);
});

test('the renderer never reads target or record metadata', () => {
  const row = scene();
  const expected = deriveRuntimeView(row);
  for (const key of ['target', 'id', 'group', 'split'])
    Object.defineProperty(row, key, {
      get: () => {
        throw new Error('renderer read metadata');
      },
    });
  assert.deepEqual(deriveRuntimeView(row), expected);
  for (const sentinel of ['TARGET_SENTINEL', 'private-row-id', 'private-group', 'eligibleIds'])
    assert.equal(expected.prompt.includes(sentinel), false);
});

test('only the last 12 chronological supplied turns enter the view and retained reply links compact', () => {
  const row = scene();
  const turns = Array.from({ length: 16 }, (_, index) => ({
    id: `original-${index}`,
    speakerId: index % 2 ? 'alpha' : 'a',
    text: `observation-${String(index).padStart(2, '0')}`,
    ...(index === 15 ? { replyTo: 'original-6' } : {}),
  }));
  const input = { ...row.input, turns };
  const before = structuredClone(input);
  const view = deriveRuntimeView({ ...row, input });
  for (let index = 0; index < 4; index++)
    assert.equal(view.prompt.includes(`observation-0${index}`), false);
  for (let index = 4; index < 16; index++)
    assert.ok(view.prompt.includes(`observation-${String(index).padStart(2, '0')}`));
  assert.match(view.prompt, /\[t1\] p2: observation-04/);
  assert.match(view.prompt, /\[t12\] p1 replies to t3: observation-15/);
  assert.deepEqual(input, before);
});

test('meeting rows without text use input while effort rows frame existing text only', () => {
  assert.match(deriveRuntimeView(scene()).prompt, /Current user message: take a look at alphabet/);
  const row = {
    task: 'effort' as const,
    text: 'raw e\u0301 text',
    input: { request: 'DO_NOT_RENDER_INPUT' },
    target: 'DO_NOT_RENDER_TARGET',
  };
  const view = deriveRuntimeView(row);
  assert.equal(view.prompt, formatDecisionPrompt('effort', row.text));
  assert.equal(row.text, 'raw e\u0301 text');
  assert.deepEqual(view.participantIds, []);
  assert.deepEqual(view.modelToOriginalIds, {});
  assert.throws(() => deriveRuntimeView({ task: 'effort', input: row.input } as never), /text/);
});

test('private derivation preserves every original field byte and refuses to overwrite output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'corral-runtime-views-'));
  try {
    const source = join(directory, 'source.jsonl');
    const output = join(directory, 'derived.jsonl');
    const row = scene();
    const raw = `  ${JSON.stringify({ ...row, text: renderMeeting(row.input) }).replace('TARGET_SENTINEL', 'TARGET_\\u0053ENTINEL')}  \r\n\n`;
    writeFileSync(source, raw, { mode: 0o600 });
    const before = readFileSync(source);
    const receipt = writeRuntimeViews(source, output);
    assert.ok(before.equals(readFileSync(source)));
    const derived = readFileSync(output, 'utf8');
    const closingBrace = raw.lastIndexOf('}');
    assert.equal(derived.slice(0, closingBrace), raw.slice(0, closingBrace));
    assert.ok(derived.endsWith(raw.slice(closingBrace)));
    const parsed = JSON.parse(derived.trim());
    const { runtimeView, ...original } = parsed;
    assert.deepEqual(original, JSON.parse(raw.trim()));
    assert.deepEqual(runtimeView.modelToOriginalIds, { p1: 'alpha', p2: 'a' });
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(receipt.rowCount, 1);
    assert.equal(receipt.exactPromptMatchCount, 0);
    assert.equal(receipt.modelToOriginalIdsIdentity, false);
    assert.throws(() => writeRuntimeViews(source, output), /new/);
    assert.ok(before.equals(readFileSync(source)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('canonical C/P inputs get an exact equivalence receipt without scores or inference', () => {
  const directory = mkdtempSync(join(tmpdir(), 'corral-runtime-equivalence-'));
  try {
    const source = join(directory, 'source.jsonl');
    const output = join(directory, 'derived.jsonl');
    const input = {
      participants: [
        { id: 'p1', name: 'One', role: '' },
        { id: 'p2', name: 'Two', role: '' },
      ],
      message: 'hello',
      turns: [{ id: 't1', speakerId: 'p1', text: 'a statement' }],
    };
    writeFileSync(
      source,
      `${[
        JSON.stringify({ task: 'meeting', input, text: renderMeeting(input) }),
        JSON.stringify({
          task: 'effort',
          text: 'provided effort text',
          target: { secret: 'not rendered' },
        }),
      ].join('\n')}\n`,
    );
    const run = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./runtime-views.ts', import.meta.url)), source, output],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
    const receipt = JSON.parse(run.stdout);
    assert.deepEqual(Object.keys(receipt).sort(), [
      'comparablePromptCount',
      'exactPromptMatchCount',
      'modelToOriginalIdsIdentity',
      'outputSha256',
      'rowCount',
      'sourceSha256',
    ]);
    assert.equal(receipt.rowCount, 2);
    assert.equal(receipt.exactPromptMatchCount, 2);
    assert.equal(receipt.modelToOriginalIdsIdentity, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('private source/output boundaries and existing runtime views are rejected', () => {
  const directory = mkdtempSync(join(tmpdir(), 'corral-runtime-private-'));
  try {
    const source = join(directory, 'source.jsonl');
    writeFileSync(source, JSON.stringify({ task: 'effort', text: 'input' }));
    writeFileSync(join(directory, '.git'), 'git marker');
    assert.throws(() => writeRuntimeViews(source, join(directory, 'output.jsonl')), /repository/);
    assert.throws(() => deriveRuntimeView({ ...scene(), runtimeView: {} } as never), /already/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
