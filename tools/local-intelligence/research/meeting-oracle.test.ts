import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { renderMeeting } from './data.ts';
import { buildOracle, deriveTarget, type FactEvent, freezeOracle } from './meeting-oracle.ts';

test('an endorsement and a later off-topic owner turn do not transfer original ownership', () => {
  const events: FactEvent[] = [
    { actor: 0, kind: 'proposal', fact: 'walk', words: ['산책', 'a walk', '散歩'] },
    { actor: 1, kind: 'repeat', fact: 'walk', words: ['찬성', 'I agree', '賛成'] },
    { actor: 0, kind: 'other', words: ['물', 'water', '水'] },
    { actor: 2, kind: 'repeat', fact: 'walk', words: ['찬성', 'I agree', '賛成'] },
  ];
  const target = deriveTarget(events, { mode: 'one', owners: ['walk'] }, ['b', 'a', 'c']);
  assert.deepEqual(target.eligibleIds, ['b']);
  assert.deepEqual(target.evidenceTurnIds, ['t1']);
});

test('name, participant-ID and roster permutations preserve rule-derived recipients', () => {
  const rows = buildOracle(41).filter(
    (row) => row.oracle.family === 'idea-owner' && row.language === 'en',
  );
  assert.equal(rows.length, 6);
  const selected = new Set<string>();
  const positions = new Set<number>();
  for (const row of rows) {
    const original = row.input.turns.find((turn) => turn.text.startsWith('My suggestion'))!;
    assert.deepEqual(row.target.eligibleIds, [original.speakerId]);
    selected.add(row.target.eligibleIds[0]!);
    positions.add(row.input.participants.findIndex((person) => person.id === original.speakerId));
    assert.equal(
      new Set(row.input.participants.map((person) => person.name)).size,
      row.input.participants.length,
    );
  }
  assert.ok(selected.size > 1);
  assert.ok(positions.size > 1);
});

test('translations and variants retain one template-family group and never leak targets into input', () => {
  const rows = buildOracle(41);
  assert.equal(rows.length, 216);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  assert.equal(new Set(rows.map((row) => row.group)).size, 12);
  for (const row of rows) {
    assert.equal(row.split, 'final');
    assert.equal(row.text, renderMeeting(row.input));
    assert.equal(row.input.message.includes('@'), false);
    for (const value of ['eligibleIds', 'excludedIds', 'oracle', row.group, row.oracle.family])
      assert.equal(row.text.includes(value), false);
    assert.deepEqual(Object.keys(row.input).sort(), ['message', 'participants', 'turns']);
    const siblings = rows.filter((other) => other.oracle.family === row.oracle.family);
    assert.equal(siblings.length, 18);
    assert.deepEqual(new Set(siblings.map((other) => other.language)), new Set(['ko', 'en', 'ja']));
    assert.ok(siblings.every((other) => other.group === row.group));
    assert.ok(row.target.excludedIds.every((id) => !row.target.eligibleIds.includes(id)));
    const ids = row.input.participants.map((person) => person.id);
    assert.ok(
      [...row.target.eligibleIds, ...row.target.excludedIds].every((id) => ids.includes(id)),
    );
    if (row.target.mode === 'none') assert.deepEqual(row.target.eligibleIds, []);
    if (row.target.mode === 'all')
      assert.deepEqual(
        new Set(row.target.eligibleIds),
        new Set(ids.filter((id) => !row.target.excludedIds.includes(id))),
      );
    if (row.oracle.family === 'open-invitation')
      assert.deepEqual(new Set(row.target.eligibleIds), new Set(ids));
  }
});

test('an exclusion resolves from facts and never becomes an eligible answer', () => {
  const events: FactEvent[] = [
    { actor: 1, kind: 'proposal', fact: 'outside', words: ['', '', ''] },
    { actor: 0, kind: 'proposal', fact: 'inside', words: ['', '', ''] },
  ];
  assert.deepEqual(
    deriveTarget(events, { mode: 'one', owners: ['inside'], excludeOwners: ['outside'] }, [
      'p2',
      'p1',
    ]).eligibleIds,
    ['p2'],
  );
  assert.deepEqual(
    deriveTarget(events, { mode: 'one', excludeOwners: ['outside'] }, ['p2', 'p1']).excludedIds,
    ['p1'],
  );
  assert.throws(
    () => deriveTarget(events, { mode: 'one', owners: ['missing'] }, ['p2', 'p1']),
    /owner/,
  );
});

test('freezing records seed, source and data hashes and refuses to overwrite a final diagnostic', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'corral-meeting-oracle-'));
  const output = join(temporary, 'frozen');
  try {
    freezeOracle(output, 41);
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.seed, 41);
    assert.equal(manifest.records, 216);
    assert.equal(manifest.groups, 12);
    assert.match(manifest.sourceSha256, /^[0-9a-f]{64}$/);
    assert.match(manifest.dataSha256, /^[0-9a-f]{64}$/);
    assert.equal(
      manifest.dataSha256,
      createHash('sha256')
        .update(readFileSync(join(output, 'final.jsonl')))
        .digest('hex'),
    );
    assert.equal(
      manifest.sourceSha256,
      createHash('sha256')
        .update(readFileSync(join(output, 'generator.ts')))
        .digest('hex'),
    );
    assert.equal(statSync(output).mode & 0o777, 0o700);
    assert.equal(statSync(join(output, 'final.jsonl')).mode & 0o777, 0o600);
    assert.throws(() => freezeOracle(output, 42), /exists|frozen/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
