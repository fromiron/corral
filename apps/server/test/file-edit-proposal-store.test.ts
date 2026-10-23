import { createHash } from 'node:crypto';
import { canonicalJson, type FileEditProposalContent } from '@corral/contracts';
import { openDatabase } from '@corral/storage-sqlite';
import { afterEach, expect, it } from 'vitest';
import { FileEditProposals } from '../src/files/file-edit-proposals.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const content: FileEditProposalContent = {
  proposalId: 'proposal_one',
  target: {
    hostId: 'host_one',
    projectId: 'default',
    bindingId: 'binding_one',
    sessionId: 'session_one',
    copyGeneration: 1,
  },
  title: 'Replace a word',
  source: { kind: 'replace', query: 'before', replacement: 'after', caseSensitive: true },
  files: [
    {
      path: 'main.ts',
      before: 'before',
      beforeHash: hash('before'),
      after: 'after',
      afterHash: hash('after'),
    },
  ],
  createdAt: '2026-10-23T00:00:00.000Z',
};
const dispose: (() => void)[] = [];
afterEach(() => {
  for (const close of dispose.splice(0)) close();
});
function setup() {
  const db = openDatabase(':memory:');
  dispose.push(() => db.close());
  return { db, store: new FileEditProposals(db) };
}

it('[TC-WBD-021-H] stores immutable content and returns the same request with lightweight summaries', () => {
  const { db, store } = setup();
  const first = store.put(content, 'request_one', hash('request'));
  expect(first).toEqual({
    ...content,
    hash: hash(canonicalJson(content)),
    dismissed: false,
    operationId: null,
  });
  expect(store.put(content, 'request_one', hash('request'))).toEqual(first);
  const second = store.put(
    { ...content, proposalId: 'proposal_two' },
    'request_one',
    hash('request'),
  );
  expect(store.forRequest('session_one', 'request_one', hash('request'))).toEqual([first, second]);
  expect(store.forRequest('session_one', 'missing', hash('request'))).toEqual([]);
  expect(store.list('session_one')).toEqual(
    [first, second].map(({ source: _source, ...item }) => ({
      ...item,
      files: item.files.map(({ path, beforeHash, afterHash }) => ({ path, beforeHash, afterHash })),
    })),
  );
  expect(store.list('session_other')).toEqual([]);
  expect(() =>
    db
      .prepare('UPDATE file_edit_proposals SET content_json=? WHERE id=?')
      .run('{}', content.proposalId),
  ).toThrow(/immutable/);
  expect(() =>
    db
      .prepare('UPDATE file_edit_proposals SET request_hash=? WHERE id=?')
      .run(hash('other'), content.proposalId),
  ).toThrow(/immutable/);
});

it('[TC-WBD-021-N] refuses reused request identity, changed content and corrupt persisted content', () => {
  const { db, store } = setup();
  store.put(content, 'request_one', hash('request'));
  expect(() => store.forRequest('session_one', 'request_one', hash('other'))).toThrow(/request/);
  expect(() =>
    store.put({ ...content, proposalId: 'proposal_two' }, 'request_one', hash('other')),
  ).toThrow(/request/);
  expect(() => store.put({ ...content, title: 'Changed' }, 'request_one', hash('request'))).toThrow(
    /changed/,
  );
  expect(() => store.put(content, 'request_other', hash('request'))).toThrow(/changed/);
  expect(() => store.get('session_other', content.proposalId)).toThrow(/unavailable/);
  db.exec('DROP TRIGGER file_edit_proposals_content_immutable');
  db.prepare('UPDATE file_edit_proposals SET content_json=? WHERE id=?').run(
    canonicalJson({ ...content, title: 'Corrupt' }),
    content.proposalId,
  );
  expect(() => store.get('session_one', content.proposalId)).toThrow(/content/);
});

it('[TC-WBD-021-F] keeps a proposal claimed by one operation and dismissal terminal', () => {
  const { db, store } = setup();
  store.put(content, 'request_one', hash('request'));
  const claimed = store.claim('session_one', content.proposalId, 'operation_one');
  expect(claimed.operationId).toBe('operation_one');
  expect(
    new FileEditProposals(db).claim('session_one', content.proposalId, 'operation_one'),
  ).toEqual(claimed);
  expect(() => store.claim('session_one', content.proposalId, 'operation_other')).toThrow(
    /claimed/,
  );
  expect(() => store.dismiss('session_one', content.proposalId)).toThrow(/claimed/);
  const second = store.put(
    { ...content, proposalId: 'proposal_two' },
    'request_one',
    hash('request'),
  );
  const dismissed = store.dismiss('session_one', second.proposalId);
  expect(dismissed.dismissed).toBe(true);
  expect(store.dismiss('session_one', second.proposalId)).toEqual(dismissed);
  expect(() => store.claim('session_one', second.proposalId, 'operation_other')).toThrow(
    /dismissed/,
  );
  expect(store.get('session_one', content.proposalId)).toEqual(claimed);
});
