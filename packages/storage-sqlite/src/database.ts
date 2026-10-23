import Database from 'better-sqlite3';
import { CANDIDATE_MIGRATION } from './candidate-migration.ts';
import { COMMAND_MIGRATION } from './command-migration.ts';
import { CORRAL_OPERATION_MIGRATION } from './corral-operation-migration.ts';
import { MEDIA_ARTIFACT_MIGRATION } from './media-migration.ts';
import { PACKAGE_MIGRATION } from './package-migration.ts';
import { SqliteProjectToolStore } from './project-tool-store.ts';
import { SCHEDULE_MIGRATION } from './schedule-migration.ts';
import { WORKBENCH_MIGRATION } from './workbench-migration.ts';

// One SQLite file per workspace (C-011, C-062). Durable settings follow the C-052 spike:
// WAL, foreign keys, FULL sync. Schema changes are numbered migrations recorded in
// `user_version`; a file from a newer build is refused, never "fixed" in place.

export type Db = Database.Database;

export interface Migration {
  name: string;
  sql: string;
  data?: (db: Db) => void;
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
  {
    name: '0008_project_tools',
    sql: `
CREATE TABLE project_tool_revisions (
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  config_json TEXT NOT NULL,
  PRIMARY KEY (project_id, revision)
) STRICT;
CREATE TABLE project_tool_trust (
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('check', 'lsp')),
  tool_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  trusted_at TEXT,
  PRIMARY KEY (project_id, kind, tool_id, fingerprint)
) STRICT;
${IMMUTABLE('project_tool_revisions')}
`,
    data(db) {
      const rows = db
        .prepare('SELECT project_id, verify_json, updated_at FROM workspace_bindings')
        .all() as { project_id: string; verify_json: string; updated_at: string }[];
      for (const row of rows) {
        const store = new SqliteProjectToolStore(db, {
          nowIso: () => row.updated_at,
          monotonicMs: () => 0,
        });
        store.save(row.project_id, 0, { checks: JSON.parse(row.verify_json), lspServers: [] });
      }
    },
  },
  {
    name: '0009_verification_reports',
    sql: 'ALTER TABLE verifications ADD COLUMN report_json TEXT;',
  },
  {
    name: '0010_mcp_trust',
    sql: `
CREATE TABLE project_tool_trust_next (
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('check', 'lsp', 'mcp')),
  tool_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  trusted_at TEXT,
  PRIMARY KEY (project_id, kind, tool_id, fingerprint)
) STRICT;
INSERT INTO project_tool_trust_next SELECT * FROM project_tool_trust;
DROP TABLE project_tool_trust;
ALTER TABLE project_tool_trust_next RENAME TO project_tool_trust;
`,
  },
  {
    name: '0011_lsp_proposals',
    sql: `
CREATE TABLE lsp_proposals (
 id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL,
 content_json TEXT NOT NULL,
 summary_json TEXT NOT NULL,
 content_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','applying','applied','partial','failed','stale','dismissed')),
 outcomes_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX lsp_proposals_by_session ON lsp_proposals(session_id,created_at);
`,
  },
  {
    name: '0012_harness_management',
    sql: `
CREATE TABLE harness_entry_management (
  hash TEXT NOT NULL REFERENCES harness_resources(hash),
  entry TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('skill','extension')),
  revision INTEGER NOT NULL,
  archived_at TEXT,
  successor_json TEXT,
  display_name TEXT,
  PRIMARY KEY(hash, entry, kind)
) STRICT;
CREATE TABLE harness_profile_management (
  profile_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  archived_at TEXT
) STRICT;
CREATE TABLE harness_management_receipts (
  operation_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL
) STRICT;
`,
  },
  {
    // CR-024: the model and reasoning an auto session uses; NULL until chosen.
    name: '0013_session_auto',
    sql: 'ALTER TABLE work_sessions ADD COLUMN auto_json TEXT;',
  },
  {
    name: '0014_auto_command_identity',
    sql: 'ALTER TABLE commands ADD COLUMN original_request_hash TEXT;',
  },
  {
    name: '0015_file_checkpoints',
    sql: `
CREATE TABLE file_checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES work_sessions(id),
  run_id TEXT,
  kind TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  manifest_hash TEXT,
  state TEXT NOT NULL CHECK (state IN ('incomplete', 'ready', 'expired')),
  pinned INTEGER NOT NULL CHECK (pinned IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, kind)
) STRICT;
CREATE INDEX checkpoints_by_session ON file_checkpoints (session_id, created_at);
CREATE TABLE checkpoint_restores (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES work_sessions(id),
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL
) STRICT;
`,
  },
  {
    name: '0016_input_images',
    sql: `CREATE TABLE input_images (
      session_id TEXT NOT NULL REFERENCES work_sessions(id), id TEXT NOT NULL,
      metadata_json TEXT NOT NULL, body BLOB NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (session_id,id)
    ) STRICT;`,
  },
  {
    name: '0017_runtime_file_checkpoints',
    sql: `CREATE TABLE file_checkpoints_next (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES work_sessions(id),
      run_id TEXT, kind TEXT NOT NULL, manifest_json TEXT NOT NULL, manifest_hash TEXT,
      state TEXT NOT NULL CHECK (state IN ('incomplete','ready','expired')),
      pinned INTEGER NOT NULL CHECK (pinned IN (0,1)), created_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO file_checkpoints_next SELECT * FROM file_checkpoints;
    DROP TABLE file_checkpoints;
    ALTER TABLE file_checkpoints_next RENAME TO file_checkpoints;
    CREATE INDEX checkpoints_by_session ON file_checkpoints(session_id,created_at);
    CREATE UNIQUE INDEX checkpoint_run_boundary ON file_checkpoints(run_id,kind) WHERE kind IN ('before_run','after_run');`,
  },
  {
    name: '0018_private_session_search',
    sql: `CREATE VIRTUAL TABLE session_search_v1 USING fts5(
      id UNINDEXED, session_id UNINDEXED, run_id UNINDEXED, entry_id UNINDEXED,
      artifact_id UNINDEXED, sequence UNINDEXED, kind UNINDEXED, normalized,
      tokenize='trigram'
    );
    CREATE TABLE session_search_state_v1 (id TEXT PRIMARY KEY, cursor TEXT NOT NULL) STRICT;`,
  },
  {
    name: '0019_message_branches',
    sql: `CREATE TABLE message_branches (
      command_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL,
      source_run_id TEXT NOT NULL REFERENCES runs(id), artifact_id TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE REFERENCES work_sessions(id), created_at TEXT NOT NULL
    ) STRICT;`,
  },
  {
    name: '0020_web_source_evidence',
    sql: `CREATE TABLE web_source_evidence (
      document_id TEXT PRIMARY KEY REFERENCES imported_inputs(id), metadata_json TEXT NOT NULL, raw_body BLOB NOT NULL
    ) STRICT;${IMMUTABLE('web_source_evidence')}`,
  },
  {
    name: '0021_run_access',
    sql: `CREATE TABLE run_access (
      run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, worktree_key TEXT NOT NULL,
      writer INTEGER NOT NULL CHECK(writer IN (0,1)),
      state TEXT NOT NULL CHECK(state IN ('active','released','uncertain')),
      tree TEXT
    ) STRICT;
    CREATE UNIQUE INDEX run_access_writer ON run_access(worktree_key)
      WHERE writer=1 AND state IN ('active','uncertain');`,
  },
  SCHEDULE_MIGRATION,
  COMMAND_MIGRATION,
  MEDIA_ARTIFACT_MIGRATION,
  PACKAGE_MIGRATION,
  CORRAL_OPERATION_MIGRATION,
  {
    name: '0027_skill_evaluations',
    sql: `
CREATE TABLE skill_evaluations (id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, view_json TEXT NOT NULL) STRICT;
CREATE TRIGGER skill_evaluations_terminal_immutable BEFORE UPDATE ON skill_evaluations
WHEN json_extract(OLD.view_json, '$.status') <> 'running'
BEGIN SELECT RAISE(ABORT, 'finished evaluations are immutable'); END;
`,
  },
  {
    name: '0028_session_auto_title',
    sql: 'ALTER TABLE work_sessions ADD COLUMN auto_title INTEGER NOT NULL DEFAULT 0 CHECK(auto_title IN (0,1));',
  },
  WORKBENCH_MIGRATION,
  {
    name: '0030_file_edit_proposals',
    sql: `
CREATE TABLE file_edit_proposals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT 0 CHECK(dismissed IN (0,1)),
  operation_id TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX file_edit_proposals_by_session ON file_edit_proposals(session_id,created_at);
CREATE INDEX file_edit_proposals_by_request ON file_edit_proposals(session_id,request_id);
CREATE TRIGGER file_edit_proposals_content_immutable
BEFORE UPDATE OF id,session_id,request_id,request_hash,content_json,content_hash,created_at
ON file_edit_proposals
BEGIN SELECT RAISE(ABORT, 'file edit proposal content is immutable'); END;
`,
  },
  {
    name: '0031_debug_trust',
    sql: `
CREATE TABLE project_tool_trust_next (
 project_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('check','lsp','mcp','debug')),
 tool_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 trusted_at TEXT,
 PRIMARY KEY(project_id,kind,tool_id,fingerprint)
) STRICT;
INSERT INTO project_tool_trust_next SELECT * FROM project_tool_trust;
DROP TABLE project_tool_trust;
ALTER TABLE project_tool_trust_next RENAME TO project_tool_trust;
`,
  },
  CANDIDATE_MIGRATION,
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
      migration.data?.(db);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}
