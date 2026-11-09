// Builds the gold items. Run by hand only. It prints counts, never conversation text.
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { type MeetingCase, meetingItems, type StoredMeeting } from './meeting.ts';
import { sampleItems } from './sample.ts';
import { assertPrivateDirectory, writePrivate } from './store.ts';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    workspace: { type: 'string', default: process.cwd() },
    seed: { type: 'string', default: 'corral-gold-1' },
  },
});
if (!values.out) throw new Error('usage: extract.ts --out <gold-dir> [--workspace <dir>]');
const out = assertPrivateDirectory(values.out);

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
  const rows = db.prepare('select id, meeting_json from work_sessions').all() as {
    id: string;
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
  }
} finally {
  db.close();
}

const items = sampleItems(meetings, { seed: values.seed, retestShare: 0.1 });
writePrivate(join(out, 'items.jsonl'), `${items.map((item) => JSON.stringify(item)).join('\n')}\n`);

const count = (key: (item: (typeof items)[number]) => string) => {
  const totals: Record<string, number> = {};
  for (const item of items) totals[key(item)] = (totals[key(item)] ?? 0) + 1;
  return totals;
};
console.log(
  JSON.stringify({
    items: items.length,
    kinds: count((i) => (i.chosen ? 'meeting-chosen' : 'meeting')),
    languages: count((i) => i.lang),
    splits: count((i) => i.split),
    retests: items.filter((i) => i.retestOf).length,
    sessions: new Set(items.map((i) => i.group)).size,
  }),
);
