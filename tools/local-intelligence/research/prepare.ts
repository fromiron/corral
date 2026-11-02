// Produce immutable per-split experiment inputs from completed teacher records.
// Usage: node prepare.ts <experiment-root> <new-dataset-directory>
import { createHash } from 'node:crypto';
import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  effortText,
  requestInput,
} from '../../../packages/local-intelligence/src/effort/preprocess.ts';
import { assertPrivateDirectory, writePrivate } from '../gold/store.ts';
import {
  assertTeacher,
  type EffortInput,
  INPUT_VERSION,
  type MeetingInput,
  renderEffort,
  renderMeeting,
  renderMeetingJoint,
  type Split,
} from './data.ts';
import { assignGroups } from './group-splits.ts';

const [root, output] = process.argv.slice(2);
if (!root || !output) throw new Error('experiment root and dataset output are required');
const out = assertPrivateDirectory(output);
if (existsSync(join(out, 'manifest.json')))
  throw new Error('dataset is frozen; use a new output directory');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
type Target = {
  level?: string;
  acceptableLevels?: string[];
  mode?: string;
  eligibleIds?: string[];
  excludedIds?: string[];
  evidence: string;
};
type Row = {
  id: string;
  group: string;
  task: 'effort' | 'meeting';
  language: string;
  input: EffortInput | MeetingInput;
  target: Target;
  provenance: { model: string; effort: string; kind: string };
};
const rows: (Row & { verifier?: Target; verifierClear?: boolean })[] = [];
for (const path of globSync('teacher/*/cases.jsonl', { cwd: root }).sort()) {
  const directory = path.split('/')[1]!;
  const receipt = JSON.parse(
    readFileSync(join(root, 'teacher', directory, 'receipt.json'), 'utf8'),
  );
  assertTeacher(receipt);
  const raw = readFileSync(join(root, 'teacher', directory, 'answer.json'), 'utf8');
  if (sha(raw) !== receipt.answerSha256) throw new Error('teacher response hash changed');
  const reviewRoot = join(root, 'verifier', directory);
  const review = new Map<string, { target: Target; clear: boolean }>();
  if (existsSync(join(reviewRoot, 'receipt.json'))) {
    assertTeacher(JSON.parse(readFileSync(join(reviewRoot, 'receipt.json'), 'utf8')));
    for (const line of readFileSync(join(reviewRoot, 'labels.jsonl'), 'utf8').trim().split('\n')) {
      const label = JSON.parse(line);
      review.set(label.id, label);
    }
  }
  for (const line of readFileSync(join(root, path), 'utf8').trim().split('\n')) {
    const row = JSON.parse(line) as Row;
    assertTeacher(row.provenance);
    if (row.group !== `${row.task}-scene-family-${String(receipt.batch).padStart(4, '0')}`)
      throw new Error('variant group changed');
    const verifier = review.get(row.id);
    rows.push({
      ...row,
      ...(verifier ? { verifier: verifier.target, verifierClear: verifier.clear } : {}),
    });
  }
}

// Connect whole conversations, but quarantine cross-split collisions instead of
// moving an already exposed group into a previously unseen holdout.
const assignments = assignGroups(
  rows.map((row) => ({
    group: row.group,
    fingerprint: sha(JSON.stringify(row.input).normalize('NFKC')),
  })),
);
const quarantined = rows.filter((r) => assignments.get(r.group)!.split === null);
const partitions: Record<Split, unknown[]> = { fit: [], calibration: [], policy: [], final: [] };
const seen = new Set<string>();
for (const row of rows) {
  if (seen.has(row.id)) throw new Error('duplicate sample ID');
  seen.add(row.id);
  const { group, split } = assignments.get(row.group)!;
  if (split === null) continue;
  let text: string,
    oldText: string | null = null,
    jointText: string | null = null;
  let candidateSpans: { id: string; start: number; end: number }[] = [];
  let pairTexts: string[] = [];
  if (row.task === 'effort') {
    const x = row.input as EffortInput;
    text = renderEffort(x);
    oldText = effortText({
      ...requestInput([x.goal, x.request].filter(Boolean).join('\n')),
      kind: x.stage === 'step' ? 'step' : 'turn',
      plan: x.plan ?? '',
      prevRequest: x.previousRequest ?? '',
      prev: x.previousReply ?? '',
      calls: (x.tools ?? []).map((t) => ({ name: t.name, args: t.args ?? '', result: t.content })),
    });
  } else {
    const x = row.input as MeetingInput;
    text = renderMeeting(x);
    pairTexts = x.participants.map((p) => renderMeeting(x, p.id));
    // Anchors follow the conversation so causal backbones can see all evidence too.
    const joint = renderMeetingJoint(x);
    jointText = joint.text;
    candidateSpans = joint.spans;
  }
  partitions[split].push({
    ...row,
    group,
    split,
    text,
    oldText,
    jointText,
    candidateSpans,
    pairTexts,
    inputVersion: INPUT_VERSION,
  });
}
const manifest: Record<string, unknown> = {
  inputVersion: INPUT_VERSION,
  createdAt: new Date().toISOString(),
  total: rows.length - quarantined.length,
  quarantined: quarantined.length,
  groups: new Set(
    rows
      .filter((r) => assignments.get(r.group)!.split !== null)
      .map((r) => assignments.get(r.group)!.group),
  ).size,
  reviewed: rows.filter((r) => r.verifier).length,
  source: 'GPT high original synthetic scenes; blind Hive high labels kept separately',
  splits: {},
};
writePrivate(
  join(out, 'quarantine.json'),
  JSON.stringify(
    quarantined.map(({ id, group }) => ({ id, group, reason: 'cross-split-duplicate' })),
    null,
    2,
  ),
);
for (const [split, items] of Object.entries(partitions)) {
  const content = items.map((r) => JSON.stringify(r)).join('\n') + (items.length ? '\n' : '');
  writePrivate(join(out, `${split}.jsonl`), content);
  (manifest.splits as Record<string, unknown>)[split] = {
    count: items.length,
    sha256: sha(content),
  };
}
writePrivate(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest));
