import Database from 'better-sqlite3';

// One SQLite file per workspace (C-011, C-062). Durable settings follow the C-052 spike:
// WAL, foreign keys, FULL sync. Schema changes are numbered migrations recorded in
// `user_version`; a file from a newer build is refused, never "fixed" in place.

export type Db = Database.Database;

export interface Migration {
  name: string;
  sql: string;
}

const IMMUTABLE = (table: string) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} rows are immutable'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} rows are immutable'); END;
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    name: '0001_initial',
    sql: `
CREATE TABLE corrals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  definition_revision INTEGER NOT NULL CHECK (definition_revision >= 1),
  layout_revision INTEGER NOT NULL CHECK (layout_revision >= 1),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE definition_versions (
  corral_id TEXT NOT NULL REFERENCES corrals(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  definition_hash TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (corral_id, revision)
) STRICT;

CREATE TABLE layouts (
  corral_id TEXT NOT NULL REFERENCES corrals(id) ON DELETE CASCADE,
  layout_revision INTEGER NOT NULL,
  definition_revision INTEGER NOT NULL,
  layout_json TEXT NOT NULL,
  PRIMARY KEY (corral_id, layout_revision)
) STRICT;

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  corral_id TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL,
  last_seq INTEGER NOT NULL,
  projection_json TEXT NOT NULL,
  started_at TEXT NOT NULL
) STRICT;
CREATE INDEX runs_by_start ON runs (started_at DESC);

CREATE TABLE run_events (
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
) STRICT;

CREATE TABLE commands (
  scope TEXT NOT NULL,
  command_id TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id),
  payload_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  directive_id TEXT,
  PRIMARY KEY (scope, command_id)
) STRICT;

CREATE TABLE artifact_texts (
  run_id TEXT NOT NULL REFERENCES runs(id),
  artifact_version_id TEXT NOT NULL,
  text_body TEXT NOT NULL,
  PRIMARY KEY (run_id, artifact_version_id)
) STRICT;

-- Current state of effects, kept in the same transaction as the events that change it.
CREATE TABLE effect_intents (
  effect_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  status TEXT NOT NULL,
  outcome TEXT
) STRICT;
${IMMUTABLE('run_events')}
${IMMUTABLE('artifact_texts')}
`,
  },
  {
    name: '0002_imported_inputs',
    sql: `
CREATE TABLE imported_inputs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('document', 'source')),
  title TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  text TEXT NOT NULL,
  url TEXT
) STRICT;
${IMMUTABLE('imported_inputs')}
`,
  },
  {
    // CR-010: projects group Corrals and runs. Existing rows join the default project; no
    // row of an immutable table is touched, and no id changes.
    name: '0003_projects',
    sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
) STRICT;
INSERT INTO projects (id, name, description, revision, created_at, updated_at, archived_at)
VALUES ('default', '', '', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL);
ALTER TABLE corrals ADD COLUMN project_id TEXT REFERENCES projects(id);
UPDATE corrals SET project_id = 'default';
ALTER TABLE runs ADD COLUMN project_id TEXT REFERENCES projects(id);
UPDATE runs SET project_id = 'default';
CREATE INDEX corrals_by_project ON corrals (project_id);
CREATE INDEX runs_by_project ON runs (project_id, started_at DESC);
`,
  },
  {
    // CR-011: work sessions continue a purpose over several runs. A run names its session in
    // a new column; snapshots and events are untouched.
    name: '0004_sessions',
    sql: `
CREATE TABLE work_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  corral_id TEXT,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  entries_json TEXT NOT NULL
) STRICT;
CREATE INDEX work_sessions_by_project ON work_sessions (project_id, updated_at DESC);
ALTER TABLE runs ADD COLUMN session_id TEXT;
CREATE INDEX runs_by_session ON runs (session_id);
`,
  },
  {
    // CR-012: a project's linked folder, sessions' managed worktrees, snapshots (git trees),
    // every file write the broker made, and verification results.
    name: '0005_workspaces',
    sql: `
CREATE TABLE workspace_bindings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
  root_path TEXT NOT NULL,
  is_git INTEGER NOT NULL CHECK (is_git IN (0, 1)),
  trusted INTEGER NOT NULL CHECK (trusted IN (0, 1)),
  verify_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE session_worktrees (
  session_id TEXT PRIMARY KEY REFERENCES work_sessions(id),
  binding_id TEXT NOT NULL REFERENCES workspace_bindings(id),
  worktree_path TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  base_tree TEXT NOT NULL,
  reviewed_tree TEXT,
  created_at TEXT NOT NULL,
  removed_at TEXT
) STRICT;
CREATE TABLE run_snapshots (
  run_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('start', 'end')),
  session_id TEXT NOT NULL,
  tree TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (run_id, phase)
) STRICT;
CREATE TABLE file_operations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('write', 'delete', 'move')),
  path TEXT NOT NULL,
  to_path TEXT,
  before_hash TEXT,
  after_hash TEXT,
  state TEXT NOT NULL CHECK (state IN ('planned', 'applied', 'failed', 'uncertain')),
  detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX file_operations_by_session ON file_operations (session_id, created_at);
CREATE TABLE verifications (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  command_json TEXT NOT NULL,
  tree TEXT NOT NULL,
  exit_code INTEGER,
  signal TEXT,
  timed_out INTEGER NOT NULL CHECK (timed_out IN (0, 1)),
  duration_ms INTEGER,
  output_tail TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'passed', 'failed', 'error')),
  started_at TEXT NOT NULL,
  ended_at TEXT
) STRICT;
CREATE INDEX verifications_by_session ON verifications (session_id, started_at);
`,
  },
  {
    // CR-013: review comments fixed to two trees, review decisions, applying an approved
    // change set to the linked folder and reverting it, file by file.
    name: '0006_review',
    sql: `
ALTER TABLE session_worktrees ADD COLUMN reviewed_at TEXT;
CREATE TABLE review_comments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  from_tree TEXT NOT NULL,
  to_tree TEXT NOT NULL,
  path TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('before', 'after')),
  start_line INTEGER NOT NULL CHECK (start_line >= 1),
  end_line INTEGER NOT NULL CHECK (end_line >= start_line),
  quote TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'submitted', 'addressed', 'obsolete')),
  batch_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX review_comments_by_session ON review_comments (session_id, created_at);
CREATE TABLE feedback_batches (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  intent TEXT NOT NULL CHECK (intent IN ('steer', 'next')),
  run_id TEXT,
  execution_id TEXT,
  text TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('sent', 'refused')),
  detail TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE review_decisions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  from_tree TEXT NOT NULL,
  to_tree TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested')),
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  decision_id TEXT NOT NULL REFERENCES review_decisions(id),
  from_tree TEXT NOT NULL,
  to_tree TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('applying', 'applied', 'partial', 'conflict', 'reverted', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE integration_files (
  integration_id TEXT NOT NULL REFERENCES integrations(id),
  path TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('write', 'delete')),
  expected_hash TEXT,
  after_hash TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('planned', 'applied', 'skipped', 'conflict', 'failed',
    'reverted', 'revert_conflict', 'uncertain')),
  detail TEXT,
  PRIMARY KEY (integration_id, path)
) STRICT;
`,
  },
  {
    name: '0007_personal_harness',
    sql: `
CREATE TABLE harness_resources (
  hash TEXT PRIMARY KEY,
  resource_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE harness_resource_trust (
  hash TEXT PRIMARY KEY REFERENCES harness_resources(hash),
  trusted_at TEXT
) STRICT;
CREATE TABLE harness_profile_revisions (
  profile_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  profile_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, revision)
) STRICT;
CREATE TABLE harness_defaults (
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'project')),
  scope_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  profile_id TEXT,
  profile_revision INTEGER,
  PRIMARY KEY (scope, scope_id),
  FOREIGN KEY (profile_id, profile_revision) REFERENCES harness_profile_revisions(profile_id, revision)
) STRICT;
${IMMUTABLE('harness_resources')}
${IMMUTABLE('harness_profile_revisions')}
`,
  },
];

/** History queries must neither recover active runs nor migrate the workspace. */
export function openReadOnlyDatabase(path: string): Db {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const version = Number(db.pragma('user_version', { simple: true }));
    if (version < 1 || version > MIGRATIONS.length)
      throw new Error('unsupported history database schema');
    db.pragma('query_only = ON');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openDatabase(path: string): Db {
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = FULL');
    db.pragma('busy_timeout = 2000');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function migrate(db: Db) {
  const current = Number(db.pragma('user_version', { simple: true }));
  if (current > MIGRATIONS.length) {
    throw new Error(
      `This database was written by a newer Corral (schema ${current}); this build reads up to ${MIGRATIONS.length}.`,
    );
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    const migration = MIGRATIONS[version] as Migration;
    db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}
