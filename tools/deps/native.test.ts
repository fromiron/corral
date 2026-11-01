import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeEvidence } from './native.ts';

test('native dependency recording exports reviewed source facts without private build fields', () => {
  const report = {
    sourceCommit: 'a'.repeat(40),
    helperSourceSha256: 'b'.repeat(64),
    privatePath: '/private/build',
    credential: 'never-export',
    dependencyEvidence: [
      {
        name: 'runtime',
        license: 'MIT',
        source: 'https://example.org/source',
        privatePath: '/private/vendor',
      },
    ],
    minimumRequiredSymbolVersions: { GLIBC: '2.38' },
  };
  const result = nativeEvidence(report, 'b'.repeat(64));
  assert.equal(result.dependencies[0]!.version, 'a'.repeat(40));
  assert.doesNotMatch(JSON.stringify(result), /private|never-export/);
  assert.throws(() => nativeEvidence(report, 'c'.repeat(64)));
  assert.throws(() =>
    nativeEvidence(
      {
        ...report,
        dependencyEvidence: [{ name: 'runtime', license: 'MIT', source: 'file:///private/vendor' }],
      },
      'b'.repeat(64),
    ),
  );
});
