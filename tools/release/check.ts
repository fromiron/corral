import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { candidateHash, ROOT } from './candidate.ts';
import { type ReleaseEvidence, verifyEvidence } from './policy.ts';

try {
  const evidence = JSON.parse(
    readFileSync(join(ROOT, 'test-results/release/evidence.json'), 'utf8'),
  ) as ReleaseEvidence;
  const livePath = process.argv[2];
  if (livePath) evidence.live = JSON.parse(readFileSync(livePath, 'utf8')).releaseProof;
  verifyEvidence(evidence, candidateHash());
  console.log(
    'Release evidence passed for current source, including separately opted-in live smoke.',
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Release evidence unavailable');
  process.exitCode = 1;
}
