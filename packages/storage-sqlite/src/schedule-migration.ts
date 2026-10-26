/** Appended to the numbered workspace migrations by database.ts. */
export const SCHEDULE_MIGRATION = {
  name: '0022_schedules',
  sql: `
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  schedule_json TEXT NOT NULL
) STRICT;
CREATE TABLE scheduled_occurrences (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id),
  revision INTEGER NOT NULL,
  occurrence_key TEXT NOT NULL,
  schedule_json TEXT NOT NULL,
  occurrence_json TEXT NOT NULL,
  UNIQUE(schedule_id, revision, occurrence_key)
) STRICT;
CREATE INDEX scheduled_occurrences_schedule ON scheduled_occurrences(schedule_id);
CREATE TABLE schedule_import_operations (
  operation_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  revision TEXT NOT NULL
) STRICT;
`,
};
