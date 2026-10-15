import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInventory, GATES, type ReleaseEvidence, verifyEvidence } from './policy.ts';

test('[TC-DX-002-H] inventory includes each exact transitive version and excludes local paths', () => {
  const inventory = createInventory(
    { MIT: [{ name: 'safe', versions: ['1.0.0', '2.0.0'], paths: ['/secret/home'] }] },
    'abc',
    '2026-10-15T00:00:00Z',
  );
  assert.equal(inventory.packages.length, 2);
  assert.equal(inventory.spdxVersion, 'SPDX-2.3');
  assert(!JSON.stringify(inventory).includes('/secret'));
});

test('[TC-DX-002-N] unknown or unreviewed licenses fail closed', () => {
  for (const license of ['UNKNOWN', 'UNLICENSED', 'GPL-3.0-only']) {
    assert.throws(
      () =>
        createInventory(
          { [license]: [{ name: 'unsafe', versions: ['1.0.0'] }] },
          'abc',
          '2026-10-15T00:00:00Z',
        ),
      /license/,
    );
  }
});

test('[TC-DX-002-N] a permissive license does not approve an unreviewed prerelease', () => {
  assert.throws(
    () =>
      createInventory(
        { MIT: [{ name: 'unreviewed-package', versions: ['1.0.0-rc.1'] }] },
        'abc',
        '2026-10-15T00:00:00Z',
      ),
    /Unreviewed prerelease/,
  );
});

test('[TC-DEV-003-N] stale, failed or missing evidence never declares a release ready', () => {
  assert.throws(() => verifyEvidence({ candidate: 'old', gates: {} }, 'new'), /candidate/);
  assert.throws(() => verifyEvidence({ candidate: 'new', gates: {} }, 'new'), /gate/);
  assert.throws(
    () =>
      verifyEvidence(
        {
          candidate: 'new',
          gates: { spec: { status: 'failed', completedAt: '2026-10-15T00:00:00Z' } },
        },
        'new',
      ),
    /gate/,
  );
});

const evidence = (): ReleaseEvidence => ({
  candidate: 'new',
  gates: Object.fromEntries(
    GATES.map((gate) => [gate, { status: 'passed', completedAt: '2026-10-15T00:00:00Z' }]),
  ),
});
test('[TC-DEV-003-H] deterministic and separately capped live proof match the candidate', () => {
  const current = evidence();
  verifyEvidence(current, 'new', false);
  current.live = {
    candidate: 'new',
    passed: true,
    completedAt: '2026-10-15T00:00:00Z',
    callsCap: 10,
    outputTokensPerCall: 256,
  };
  verifyEvidence(current, 'new');
});
test('[TC-DEV-004-H] [TC-DEV-004-N] absent, failed, stale and uncapped live proof remains a blocking result', () => {
  assert.throws(() => verifyEvidence(evidence(), 'new'), /live smoke/);
  for (const patch of [
    { passed: false },
    { candidate: 'old' },
    { callsCap: 11 },
    { outputTokensPerCall: 257 },
    { outputTokensPerCall: 0 },
    { callsCap: Number.NaN },
  ]) {
    const current = evidence();
    current.live = {
      candidate: 'new',
      passed: true,
      completedAt: '2026-10-15T00:00:00Z',
      callsCap: 10,
      outputTokensPerCall: 256,
      ...patch,
    };
    assert.throws(() => verifyEvidence(current, 'new'), /live smoke/);
  }
});

test('CPU flamegraph encodes measured sample time and escapes function labels', async () => {
  const { flamegraph } = await import('./profile.ts');
  const svg = flamegraph({
    nodes: [
      { id: 1, callFrame: { functionName: '(root)' }, children: [2] },
      { id: 2, callFrame: { functionName: '<unsafe>' } },
    ],
    samples: [1, 2],
    timeDeltas: [1000, 3000],
  });
  assert(svg.includes('width="900.00"'));
  assert(svg.includes('&lt;unsafe&gt;'));
  assert(!svg.includes('<unsafe>'));
  assert.throws(() => flamegraph({ nodes: [] }), /no timed samples/);
});

test('candidate proof changes for new, modified and deleted source but ignores generated output', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { candidateHash } = await import('./candidate.ts');
  const root = mkdtempSync(join(tmpdir(), 'corral-candidate-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'fixture'], { cwd: root });
    writeFileSync(join(root, '.gitignore'), 'output/\n');
    writeFileSync(join(root, 'source.ts'), 'original');
    execFileSync('git', ['add', '.'], { cwd: root });
    const original = candidateHash(root);
    mkdirSync(join(root, 'output'));
    writeFileSync(join(root, 'output/evidence.json'), 'generated');
    assert.equal(candidateHash(root), original);
    writeFileSync(join(root, 'source.ts'), 'edited');
    assert.notEqual(candidateHash(root), original);
    writeFileSync(join(root, 'source.ts'), 'original');
    writeFileSync(join(root, 'new.ts'), 'new');
    assert.notEqual(candidateHash(root), original);
    rmSync(join(root, 'new.ts'));
    rmSync(join(root, 'source.ts'));
    assert.notEqual(candidateHash(root), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
