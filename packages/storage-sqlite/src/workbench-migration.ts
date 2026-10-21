/** CR-046: Run and human effects reserve the same canonical working copy. */
export const WORKBENCH_MIGRATION = {
  name: '0029_workbench_ownership',
  sql: `
ALTER TABLE session_worktrees ADD COLUMN copy_generation INTEGER NOT NULL DEFAULT 1
  CHECK(copy_generation >= 1);
CREATE TABLE workspace_access (
  owner_kind TEXT NOT NULL CHECK(owner_kind IN ('run','user')),
  owner_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  worktree_key TEXT NOT NULL,
  copy_generation INTEGER NOT NULL CHECK(copy_generation >= 1),
  writer INTEGER NOT NULL CHECK(writer IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('active','released','uncertain')),
  tree TEXT,
  PRIMARY KEY(owner_kind, owner_id)
) STRICT;
INSERT INTO workspace_access
  (owner_kind, owner_id, session_id, worktree_key, copy_generation, writer, state, tree)
  SELECT 'run', a.run_id, a.session_id, a.worktree_key, COALESCE(w.copy_generation, 1),
    a.writer, a.state, a.tree
  FROM run_access a LEFT JOIN session_worktrees w ON w.session_id=a.session_id;
CREATE UNIQUE INDEX workspace_access_writer ON workspace_access(worktree_key)
  WHERE writer=1 AND state IN ('active','uncertain');
DROP TABLE run_access;
CREATE TABLE workbench_operations (
  operation_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  target_json TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed','cancelled','uncertain')),
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
`,
};
