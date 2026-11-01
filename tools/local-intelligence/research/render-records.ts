// Add the canonical model views to private raw records without changing labels or groups.
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  effortText,
  requestInput,
} from '../../../packages/local-intelligence/src/effort/preprocess.ts';
import { assertPrivateDirectory, writePrivate } from '../gold/store.ts';
import {
  type EffortInput,
  INPUT_VERSION,
  type MeetingInput,
  renderEffort,
  renderMeeting,
  renderMeetingJoint,
} from './data.ts';

const [source, output] = process.argv.slice(2);
if (!source || !output || existsSync(output)) throw new Error('source and new output required');
assertPrivateDirectory(dirname(output));
const rows = readFileSync(source, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((s) => JSON.parse(s));
for (const row of rows) {
  if (row.task === 'effort') {
    const x = row.input as EffortInput;
    row.text = renderEffort(x);
    row.oldText = effortText({
      ...requestInput([x.goal, x.request].filter(Boolean).join('\n')),
      kind: x.stage === 'step' ? 'step' : 'turn',
      prevRequest: x.previousRequest ?? '',
      prev: x.previousReply ?? '',
      plan: x.plan ?? '',
      calls: (x.tools ?? []).map((t) => ({ name: t.name, args: t.args ?? '', result: t.content })),
    });
  } else if (row.task === 'meeting') {
    const x = row.input as MeetingInput;
    const joint = renderMeetingJoint(x);
    row.text = renderMeeting(x);
    row.oldText = null;
    row.jointText = joint.text;
    row.candidateSpans = joint.spans;
    row.pairTexts = x.participants.map((p) => renderMeeting(x, p.id));
  } else throw new Error('unknown task');
  row.inputVersion = INPUT_VERSION;
}
writePrivate(output, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(JSON.stringify({ records: rows.length, inputVersion: INPUT_VERSION }));
