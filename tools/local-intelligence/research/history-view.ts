// A controlled input-only alternative. IDs, groups, labels and split membership stay identical.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertPrivateDirectory, writePrivate } from '../gold/store.ts';
import { type MeetingInput, renderCandidateHistory } from './data.ts';

const [source, destination] = process.argv.slice(2);
if (!source || !destination || existsSync(destination))
  throw new Error('source and new destination required');
const out = assertPrivateDirectory(destination);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
manifest.parentManifestSha256 = sha(readFileSync(join(source, 'manifest.json'), 'utf8'));
manifest.inputVersion = 'judge-candidate-history-v1';
for (const split of ['fit', 'calibration', 'policy', 'final']) {
  const rows = readFileSync(join(source, `${split}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((s) => JSON.parse(s));
  for (const row of rows) {
    if (row.task !== 'meeting') continue;
    const input = row.input as MeetingInput;
    row.pairTexts = input.participants.map((p) => renderCandidateHistory(input, p.id));
    row.inputVersion = manifest.inputVersion;
  }
  const content = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writePrivate(join(out, `${split}.jsonl`), content);
  manifest.splits[split] = { count: rows.length, sha256: sha(content) };
}
writePrivate(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ total: manifest.total, inputVersion: manifest.inputVersion }));
