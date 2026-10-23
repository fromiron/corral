import type { Migration } from './database.ts';

export const CANDIDATE_MIGRATION: Migration = {
  name: '0032_candidate_worktrees',
  sql: `
CREATE TABLE candidate_worktrees (
  run_id TEXT NOT NULL REFERENCES runs(id), candidate_id TEXT NOT NULL,
  session_id TEXT NOT NULL, binding_id TEXT NOT NULL, copy_generation INTEGER NOT NULL,
  worktree_path TEXT NOT NULL UNIQUE, baseline_tree TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('creating','ready','removed','uncertain')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id,candidate_id)
) STRICT;
CREATE TABLE candidate_executions (
  run_id TEXT NOT NULL, execution_id TEXT NOT NULL, candidate_id TEXT NOT NULL,
  PRIMARY KEY(run_id,execution_id),
  FOREIGN KEY(run_id,candidate_id) REFERENCES candidate_worktrees(run_id,candidate_id)
) STRICT;
CREATE TABLE candidate_promotions (
  run_id TEXT PRIMARY KEY REFERENCES runs(id), request_hash TEXT NOT NULL,
  command_id TEXT NOT NULL, checkpoint_id TEXT NOT NULL
) STRICT;
`,
};
