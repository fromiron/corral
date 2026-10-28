import { createHash } from 'node:crypto';
import {
  type RunEvent,
  type SessionSearchHit,
  SessionSearchRequest,
  type SessionSearchResult,
  type SessionSearchSource,
} from '@corral/contracts';
import type { Db } from '@corral/storage-sqlite';

const normalize = (text: string) => text.normalize('NFKC').toLowerCase();
const sourceHash = (text: string) => createHash('sha256').update(text).digest('hex');
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function sourceExcerpt(text: string, normalized: string, query: string) {
  const match = normalized.indexOf(query);
  if (match < 0) throw new Error('search source does not contain the normalized query');
  const from = Math.max(0, match - 70);
  const to = Math.min(normalized.length, Math.max(from + 240, match + query.length));
  // Decomposed lengths stay additive when NFKC composes across raw graphemes (e.g. ㄱㅏ).
  const decomposedFrom = normalized.slice(0, from).normalize('NFKD').length;
  const decomposedTo = decomposedFrom + normalized.slice(from, to).normalize('NFKD').length;
  const segments: { start: number; end: number; rawStart: number; rawEnd: number }[] = [];
  let offset = 0;
  for (const { segment, index } of graphemes.segment(text)) {
    const end = offset + segment.normalize('NFKD').toLowerCase().normalize('NFKD').length;
    if (end > decomposedFrom)
      segments.push({ start: offset, end, rawStart: index, rawEnd: index + segment.length });
    offset = end;
    if (offset >= decomposedTo) break;
  }
  const start = segments[0]?.rawStart ?? 0;
  const excerpt = text.slice(start, segments.at(-1)?.rawEnd ?? 240);
  const excerptMatches: { start: number; end: number }[] = [];
  for (
    let at = normalized.indexOf(query, from);
    at >= 0 && at + query.length <= to;
    at = normalized.indexOf(query, at + query.length)
  ) {
    const matchStart = decomposedFrom + normalized.slice(from, at).normalize('NFKD').length;
    const matchEnd = matchStart + normalized.slice(at, at + query.length).normalize('NFKD').length;
    const first = segments.find((segment) => segment.end > matchStart);
    const last = segments.findLast((segment) => segment.start < matchEnd);
    if (first && last) {
      const range = { start: first.rawStart - start, end: last.rawEnd - start };
      const previous = excerptMatches.at(-1);
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else excerptMatches.push(range);
    }
  }
  return { excerpt, excerptMatches };
}

/** Derived, local-only search data. Rebuilding never changes the source sessions or history. */
export class SessionSearch {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  rebuild() {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM session_search_v1').run();
      this.db.prepare('DELETE FROM session_search_state_v1').run();
    })();
  }

  private sync(includeTranscript: boolean) {
    this.db.transaction(() => {
      this.db
        .prepare(
          'DELETE FROM session_search_v1 WHERE session_id NOT IN (SELECT id FROM work_sessions)',
        )
        .run();
      const state = this.db.prepare('SELECT cursor FROM session_search_state_v1 WHERE id=?');
      const mark = this.db.prepare(
        'INSERT INTO session_search_state_v1 VALUES (?,?) ON CONFLICT(id) DO UPDATE SET cursor=excluded.cursor',
      );
      const add = this.db.prepare(
        'INSERT INTO session_search_v1(id,session_id,run_id,entry_id,artifact_id,sequence,kind,normalized,source_text,source_hash) VALUES (?,?,?,?,?,?,?,?,?,?)',
      );
      const sessions = this.db
        .prepare(
          'SELECT s.*,p.name AS project_name,p.revision AS project_revision FROM work_sessions s JOIN projects p ON p.id=s.project_id',
        )
        .all() as {
        id: string;
        title: string;
        objective: string;
        revision: number;
        project_name: string;
        project_revision: number;
        entries_json: string;
      }[];
      for (const session of sessions) {
        const id = `metadata:${session.id}`,
          cursor = `${session.revision}:${session.project_revision}`;
        if ((state.get(id) as { cursor: string } | undefined)?.cursor !== cursor) {
          this.db.prepare('DELETE FROM session_search_v1 WHERE id=?').run(id);
          const text = `${session.project_name}\n${session.title}\n${session.objective}\n${session.id}`;
          add.run(
            id,
            session.id,
            null,
            null,
            null,
            null,
            'session',
            normalize(text),
            text,
            sourceHash(text),
          );
          mark.run(id, cursor);
        }
        if (!includeTranscript) continue;
        const entryKey = `entries:${session.id}`;
        if (
          (state.get(entryKey) as { cursor: string } | undefined)?.cursor !==
          String(session.revision)
        ) {
          this.db
            .prepare("DELETE FROM session_search_v1 WHERE session_id=? AND kind='entry'")
            .run(session.id);
          const entries = JSON.parse(session.entries_json) as {
            entryId: string;
            text: string;
            runId?: string;
            attachments?: { text: string; name: string }[];
          }[];
          for (const entry of entries) {
            const text = [
              entry.text,
              ...(entry.attachments ?? []).map((item) => `${item.name}\n${item.text}`),
            ].join('\n');
            add.run(
              `entry:${session.id}:${entry.entryId}`,
              session.id,
              entry.runId ?? null,
              entry.entryId,
              null,
              null,
              'entry',
              normalize(text),
              text,
              sourceHash(text),
            );
          }
          mark.run(entryKey, String(session.revision));
        }
      }
      if (!includeTranscript) return;
      const runs = this.db
        .prepare(
          'SELECT id,session_id,last_seq FROM runs WHERE session_id IN (SELECT id FROM work_sessions)',
        )
        .all() as { id: string; session_id: string; last_seq: number }[];
      for (const run of runs) {
        const key = `run:${run.id}`,
          cursor = Number((state.get(key) as { cursor: string } | undefined)?.cursor ?? 0);
        if (cursor === run.last_seq) continue;
        const rows = this.db
          .prepare('SELECT event_json FROM run_events WHERE run_id=? AND seq>? ORDER BY seq')
          .all(run.id, cursor) as { event_json: string }[];
        for (const row of rows) {
          const event = JSON.parse(row.event_json) as RunEvent;
          let ref: string | undefined,
            body: string | undefined,
            kind: SessionSearchHit['kind'] = 'interaction';
          if (event.type === 'artifact.version_created') {
            ref = event.payload.artifactVersionId;
            kind = 'artifact';
          } else if (event.type === 'model.finished') {
            if (!event.payload.responseRef) continue;
            ref = event.payload.responseRef;
            kind = 'response';
          } else if (
            event.type === 'user_input.requested' ||
            event.type === 'extension.ui_requested'
          )
            ref = event.payload.bodyRef;
          else if (event.type === 'user_input.answered' || event.type === 'extension.ui_answered')
            ref = event.payload.answerRef;
          else if (event.type === 'directive.accepted') body = event.payload.text;
          else continue;
          if (ref)
            body = (
              this.db
                .prepare(
                  'SELECT text_body FROM artifact_texts WHERE run_id=? AND artifact_version_id=?',
                )
                .get(run.id, ref) as { text_body: string } | undefined
            )?.text_body;
          if (body === undefined) throw new Error('private search source is incomplete');
          add.run(
            `event:${run.id}:${event.runSeq}`,
            run.session_id,
            run.id,
            null,
            kind === 'artifact' ? ref : null,
            event.runSeq,
            kind,
            normalize(body),
            body,
            sourceHash(body),
          );
        }
        mark.run(key, String(run.last_seq));
      }
    })();
  }

  search(raw: SessionSearchRequest): SessionSearchResult {
    const request = SessionSearchRequest.parse(raw),
      query = normalize(request.query);
    this.sync(request.includeTranscript);
    const indexed = [...query].length >= 3;
    const match = indexed
      ? 'session_search_v1 MATCH ? AND instr(d.normalized,?)>0'
      : 'instr(d.normalized,?)>0';
    const parameters = [
      ...(indexed ? [`"${query.replaceAll('"', '""')}"`, query] : [query]),
      Number(request.includeTranscript),
      Number(request.includeArchived),
      request.projectId ?? null,
      request.projectId ?? null,
    ];
    const from = `FROM session_search_v1 d JOIN work_sessions s ON s.id=d.session_id JOIN projects p ON p.id=s.project_id
      WHERE ${match} AND (?=1 OR d.kind='session') AND (?=1 OR (s.archived_at IS NULL AND p.archived_at IS NULL)) AND (? IS NULL OR s.project_id=?)`;
    const group = `CASE WHEN d.run_id IS NULL THEN json_array(d.id) ELSE json_array(d.session_id,d.run_id,d.source_hash) END`;
    const total = (
      this.db
        .prepare(`SELECT count(*) AS n FROM (SELECT 1 ${from} GROUP BY ${group})`)
        .get(...parameters) as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT d.*,s.title,s.project_id,s.archived_at,p.archived_at AS project_archived,
        max(d.rowid) AS newest,
        json_group_array(json_object('kind',d.kind,'runId',d.run_id,'entryId',d.entry_id,'artifactVersionId',d.artifact_id,'sequence',d.sequence)) AS sources,
        (SELECT count(*) FROM runs older JOIN runs current ON current.id=d.run_id
          WHERE older.session_id=current.session_id AND
            (older.started_at<current.started_at OR (older.started_at=current.started_at AND older.rowid<=current.rowid))) AS run_number
        ${from} GROUP BY ${group}
        ORDER BY CASE d.kind WHEN 'session' THEN 0 ELSE 1 END,s.updated_at DESC,newest DESC LIMIT 50 OFFSET ?`,
      )
      .all(...parameters, request.offset) as {
      session_id: string;
      title: string;
      project_id: string;
      kind: SessionSearchHit['kind'];
      run_id: string | null;
      entry_id: string | null;
      artifact_id: string | null;
      sequence: number | null;
      normalized: string;
      source_text: string;
      sources: string;
      run_number: number;
      archived_at: string | null;
      project_archived: string | null;
    }[];
    return {
      indexVersion: 1,
      scope: request.includeTranscript ? 'private_transcript' : 'metadata',
      total,
      hits: rows.map((row) => {
        const sources = (JSON.parse(row.sources) as SessionSearchSource[]).sort(
          (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0),
        );
        return {
          sessionId: row.session_id,
          title: row.title,
          projectId: row.project_id,
          kind: row.kind,
          runId: row.run_id,
          entryId: row.entry_id,
          artifactVersionId: row.artifact_id,
          sequence: row.sequence === null ? null : Number(row.sequence),
          ...sourceExcerpt(row.source_text, row.normalized, query),
          ...(row.run_number ? { runNumber: row.run_number } : {}),
          ...(sources.length > 1 ? { sources } : {}),
          archived: Boolean(row.archived_at || row.project_archived),
        };
      }),
    };
  }
}
