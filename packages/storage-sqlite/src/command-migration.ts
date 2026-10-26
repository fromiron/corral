/** command effects survive host restart without being replayed. */
export const COMMAND_MIGRATION = {
  name: '0023_command_operations',
  sql: `CREATE TABLE command_operations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES work_sessions(id),
    run_id TEXT NOT NULL REFERENCES runs(id),
    request_hash TEXT NOT NULL,
    owner_json TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('running','completed','failed','cancelled','uncertain')),
    report_json TEXT,
    before_tree TEXT NOT NULL,
    after_tree TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX command_operations_session ON command_operations(session_id,created_at);`,
};
