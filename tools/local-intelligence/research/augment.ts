// Generate training-only identity variants, keeping original scenario groups.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertPrivateDirectory, writePrivate } from '../gold/store.ts';
import { renderMeeting, renderMeetingJoint } from './data.ts';
import { permuteCanonicalRoster, permuteMeeting, remapTarget } from './permutation.ts';

const [data, output] = process.argv.slice(2);
if (!data || !output || existsSync(output)) throw new Error('provide data and a new output file');
assertPrivateDirectory(dirname(output));
const source = readFileSync(join(data, 'fit.jsonl'), 'utf8');
const canonical = process.argv.includes('--canonical-roster');
const variant = canonical ? 'canonical-roster-41' : 'permutation-41';
const variants = [];
for (const line of source.trim().split('\n')) {
  const row = JSON.parse(line);
  if (row.split !== 'fit') throw new Error('augmentation source must be fit only');
  if (row.task !== 'meeting') continue;
  const shuffle = (salt: string) =>
    row.input.participants
      .map((_: unknown, i: number) => i)
      .sort((a: number, b: number) =>
        createHash('sha256')
          .update(`${row.id}:${salt}:${a}`)
          .digest('hex')
          .localeCompare(createHash('sha256').update(`${row.id}:${salt}:${b}`).digest('hex')),
      );
  const ids = shuffle('identity').map((i: number) => row.input.participants[i].id);
  const changed = canonical
    ? permuteCanonicalRoster(row.input, shuffle('roster'))
    : permuteMeeting(row.input, ids, shuffle('roster'));
  const joint = renderMeetingJoint(changed.input);
  variants.push({
    ...row,
    id: `${row.id}:${variant}`,
    originalId: row.id,
    input: changed.input,
    target: remapTarget(row.target, changed.remap),
    ...(row.verifier ? { verifier: remapTarget(row.verifier, changed.remap) } : {}),
    text: renderMeeting(changed.input),
    jointText: joint.text,
    candidateSpans: joint.spans,
    pairTexts: changed.input.participants.map((p) => renderMeeting(changed.input, p.id)),
    augmentation: canonical
      ? 'runtime-canonical-roster-permutation-41'
      : 'identity-and-roster-permutation-41',
  });
}
writePrivate(output, variants.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(
  JSON.stringify({
    count: variants.length,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
  }),
);
