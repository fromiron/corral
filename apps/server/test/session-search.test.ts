import { openDatabase } from '@corral/storage-sqlite';
import { expect, it } from 'vitest';
import { SessionSearch } from '../src/session-search.ts';

it('[TC-CONTINUITY-001-H] [TC-CONTINUITY-001-N] searches private multilingual entries literally and rebuilds without reviving archived or removed sessions', () => {
  const db = openDatabase(':memory:');
  try {
    const entries = [
      { entryId: 'entry_one', text: '설정 확인 日本語 src/work_plan.ts token_identifier' },
    ];
    db.prepare(
      "INSERT INTO work_sessions (id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,archived_at,entries_json) VALUES ('session_search','default',NULL,'Metadata title','Objective',0,1,'x','x',NULL,?)",
    ).run(JSON.stringify(entries));
    const search = new SessionSearch(db);
    expect(search.search({ query: '설정', includeTranscript: false }).hits).toHaveLength(0);
    expect(search.search({ query: 'Metadata', includeTranscript: false }).hits[0]?.kind).toBe(
      'session',
    );
    for (const query of ['설정', '日本語', 'src/work_plan.ts', 'token_identifier']) {
      expect(search.search({ query, includeTranscript: true }).hits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: 'session_search',
            entryId: 'entry_one',
            kind: 'entry',
          }),
        ]),
      );
    }
    expect(search.search({ query: '" OR *', includeTranscript: true }).hits).toHaveLength(0);
    db.prepare("UPDATE work_sessions SET archived_at='x' WHERE id='session_search'").run();
    expect(search.search({ query: '설정', includeTranscript: true }).hits).toHaveLength(0);
    expect(
      search.search({ query: '설정', includeTranscript: true, includeArchived: true }).hits,
    ).toHaveLength(1);
    search.rebuild();
    expect(
      search.search({ query: '日本語', includeTranscript: true, includeArchived: true })
        .indexVersion,
    ).toBe(1);
    db.prepare("DELETE FROM work_sessions WHERE id='session_search'").run();
    expect(
      search.search({ query: '日本語', includeTranscript: true, includeArchived: true }).hits,
    ).toHaveLength(0);
  } finally {
    db.close();
  }
});
