// Builds the gold items. Run by hand only. It prints counts, never conversation text.
import { createReadStream, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { requestInput } from '../../../packages/local-intelligence/src/effort/preprocess.ts';
import { codexRequests, type HumanRequest } from './codex.ts';
import { type MeetingCase, meetingItems, type StoredMeeting } from './meeting.ts';
import { sampleItems } from './sample.ts';
import { scrub } from './scrub.ts';
import { assertPrivateDirectory, writePrivate } from './store.ts';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    workspace: { type: 'string', default: process.cwd() },
    codex: { type: 'string', default: join(homedir(), '.codex', 'sessions') },
    seed: { type: 'string', default: 'corral-gold-1' },
    'max-steps': { type: 'string', default: '120' },
    'steps-per-session': { type: 'string', default: '8' },
  },
});
if (!values.out)
  throw new Error('usage: extract.ts --out <gold-dir> [--workspace <dir>] [--codex <dir>]');
const out = assertPrivateDirectory(values.out);

// Large tool outputs and reasoning rows are skipped line by line, so big sessions fit in memory.
async function relevantLines(path: string) {
  const lines: string[] = [];
  const input = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of input) {
    const kept = line.includes('"type":"response_item"') || line.includes('"type":"session_meta"');
    if (kept && !line.includes('"type":"reasoning"')) lines.push(line);
  }
  return lines;
}

function sessionFiles(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

const requests: HumanRequest[] = [];
for (const path of sessionFiles(values.codex))
  requests.push(...codexRequests([await relevantLines(path)]));

const db = new DatabaseSync(join(values.workspace, '.corral', 'corral.db'), { readOnly: true });
const meetings: MeetingCase[] = [];
try {
  const finished = db.prepare(
    `select event_json from run_events e join runs r on r.id = e.run_id
     where e.run_id = ? and e.type = 'output.finalized' and r.status = 'succeeded'
     order by e.seq desc limit 1`,
  );
  const body = db.prepare(
    'select text_body from artifact_texts where run_id = ? and artifact_version_id = ?',
  );
  const answerText = (runId: string) => {
    const row = finished.get(runId) as { event_json: string } | undefined;
    if (!row) return null;
    const ids = (JSON.parse(row.event_json) as { payload: { artifactVersionIds?: string[] } })
      .payload.artifactVersionIds;
    const texts = (ids ?? []).flatMap((id) => {
      const text = body.get(runId, id) as { text_body: string } | undefined;
      return text ? [text.text_body] : [];
    });
    return texts.length ? texts.join('\n\n') : null;
  };
  const rows = db.prepare('select id, entries_json, meeting_json from work_sessions').all() as {
    id: string;
    entries_json: string;
    meeting_json: string | null;
  }[];
  for (const row of rows) {
    if (row.meeting_json)
      meetings.push(
        ...meetingItems(
          { ...(JSON.parse(row.meeting_json) as StoredMeeting), id: row.id },
          answerText,
        ),
      );
    const entries = JSON.parse(row.entries_json) as {
      text?: string;
      auto?: unknown;
      meetingHandoff?: unknown;
    }[];
    for (const entry of entries)
      if (entry.text?.trim() && !entry.auto && !entry.meetingHandoff)
        requests.push({ session: row.id, turn: requestInput(scrub(entry.text)), steps: [] });
  }
} finally {
  db.close();
}

const items = sampleItems(requests, meetings, {
  seed: values.seed,
  maxSteps: Number(values['max-steps']),
  stepsPerSession: Number(values['steps-per-session']),
  retestShare: 0.1,
});
writePrivate(join(out, 'items.jsonl'), `${items.map((item) => JSON.stringify(item)).join('\n')}\n`);

const count = (key: (item: (typeof items)[number]) => string) => {
  const totals: Record<string, number> = {};
  for (const item of items) totals[key(item)] = (totals[key(item)] ?? 0) + 1;
  return totals;
};
console.log(
  JSON.stringify({
    items: items.length,
    kinds: count((i) =>
      i.kind === 'effort' ? i.input.kind : i.chosen ? 'meeting-chosen' : 'meeting',
    ),
    languages: count((i) => i.lang),
    splits: count((i) => i.split),
    retests: items.filter((i) => i.retestOf).length,
    sessions: new Set(items.map((i) => i.group)).size,
  }),
);
