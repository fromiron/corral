import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock } from '@corral/testkit';
import { afterEach, expect, it } from 'vitest';
import { ReviewService } from '../src/files/review.ts';
import type { WorkspaceService } from '../src/files/service.ts';

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = openDatabase(':memory:');
  databases.push(db);
  db.prepare(`INSERT INTO work_sessions
    (id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,archived_at,entries_json)
    VALUES ('session','default',NULL,'Terminal only','',0,1,'now','now',NULL,'[]')`).run();
  db.prepare(`INSERT INTO workspace_bindings
    (id,project_id,root_path,is_git,trusted,verify_json,created_at,updated_at)
    VALUES ('binding','default','/fixture-source',1,1,'[]','now','now')`).run();
  db.prepare(`INSERT INTO session_worktrees
    (session_id,binding_id,worktree_path,base_commit,base_tree,created_at,copy_generation)
    VALUES ('session','binding','/fixture-copy','commit','tree','now',1)`).run();
  const target = {
    hostId: 'local',
    projectId: 'default',
    bindingId: 'binding',
    sessionId: 'session',
    copyGeneration: 1,
  };
  db.prepare(`INSERT INTO workbench_operations
    (operation_id,request_hash,target_json,kind,state,result_json,created_at,updated_at)
    VALUES ('terminal','hash',?,'terminal','uncertain','{"private":"do not expose"}','now','now')`).run(
    JSON.stringify(target),
  );
  db.prepare(`INSERT INTO workspace_access
    (owner_kind,owner_id,session_id,worktree_key,copy_generation,writer,state,tree)
    VALUES ('user','terminal','session','/fixture-copy',1,1,'uncertain',NULL)`).run();
  const review = new ReviewService({
    db,
    clock: new FakeClock(),
    files: { copyOf: () => null } as unknown as WorkspaceService,
  });
  const sessions = [{ sessionId: 'session', title: 'Terminal only', entries: [] }];
  return { db, target, review, inbox: () => review.inbox(sessions, []) };
}

it('reports the exact unconfirmed terminal writer even when the session has no runs or messages', () => {
  const { db, inbox } = fixture();
  const before = db.prepare('SELECT * FROM workspace_access').all();
  expect(inbox()).toEqual([
    {
      kind: 'uncertain_terminal',
      sessionId: 'session',
      sessionTitle: 'Terminal only',
      runId: null,
      terminalId: 'terminal',
      detail: null,
    },
  ]);
  expect(JSON.stringify(inbox())).not.toContain('private');
  expect(db.prepare('SELECT * FROM workspace_access').all()).toEqual(before);
  expect(db.prepare('SELECT state FROM workbench_operations').get()).toEqual({
    state: 'uncertain',
  });
});

it('lists unresolved terminal attention across projects while each project inbox stays scoped', () => {
  const { db, target, review, inbox } = fixture();
  db.prepare(`INSERT INTO projects VALUES ('other','Other','',1,'now','now',NULL)`).run();
  db.prepare(`INSERT INTO work_sessions
    (id,project_id,corral_id,title,objective,pinned,revision,created_at,updated_at,archived_at,entries_json)
    VALUES ('other_session','other',NULL,'Other terminal','',0,1,'now','now',NULL,'[]')`).run();
  db.prepare(`INSERT INTO workspace_bindings
    (id,project_id,root_path,is_git,trusted,verify_json,created_at,updated_at)
    VALUES ('other_binding','other','/other-source',1,1,'[]','now','now')`).run();
  db.prepare(`INSERT INTO session_worktrees
    (session_id,binding_id,worktree_path,base_commit,base_tree,created_at,copy_generation)
    VALUES ('other_session','other_binding','/other-copy','commit','tree','now',1)`).run();
  db.prepare(`INSERT INTO workbench_operations
    (operation_id,request_hash,target_json,kind,state,result_json,created_at,updated_at)
    VALUES ('other_terminal','hash',?,'terminal','uncertain',NULL,'now','now')`).run(
    JSON.stringify({
      ...target,
      projectId: 'other',
      sessionId: 'other_session',
      bindingId: 'other_binding',
    }),
  );
  db.prepare(`INSERT INTO workspace_access
    (owner_kind,owner_id,session_id,worktree_key,copy_generation,writer,state,tree)
    VALUES ('user','other_terminal','other_session','/other-copy',1,1,'uncertain',NULL)`).run();
  expect(
    review
      .terminalAttention()
      .map((item) => item.sessionId)
      .sort(),
  ).toEqual(['other_session', 'session']);
  expect(inbox().map((item) => item.sessionId)).toEqual(['session']);
  db.prepare("UPDATE projects SET archived_at='archived' WHERE id='other'").run();
  expect(review.terminalAttention().map((item) => item.sessionId)).toEqual(['session']);
  db.prepare("UPDATE work_sessions SET archived_at='archived' WHERE id='session'").run();
  expect(review.terminalAttention()).toEqual([]);
});

it.each([
  "UPDATE workspace_access SET state='released'",
  "UPDATE workspace_access SET state='active'",
  'UPDATE workspace_access SET writer=0',
  "UPDATE workspace_access SET owner_kind='run'",
  "UPDATE workspace_access SET session_id='another'",
  'UPDATE workspace_access SET copy_generation=2',
  'UPDATE session_worktrees SET copy_generation=2',
  "UPDATE session_worktrees SET removed_at='removed'",
  "UPDATE workbench_operations SET kind='task'",
  "UPDATE workbench_operations SET target_json=json_set(target_json,'$.sessionId','another')",
  "UPDATE workbench_operations SET target_json=json_set(target_json,'$.copyGeneration',2)",
  "UPDATE workbench_operations SET target_json=json_set(target_json,'$.bindingId','another')",
  "UPDATE workbench_operations SET target_json=json_set(target_json,'$.projectId','another')",
])('does not report a resolved or mismatched terminal owner: %s', (change) => {
  const { db, inbox } = fixture();
  db.prepare(change).run();
  expect(inbox()).toEqual([]);
});
