/** Commit an import receipt in the same transaction as its Corral revision. */
export const CORRAL_OPERATION_MIGRATION = {
  name: '0026_corral_operations',
  sql: `
CREATE TABLE corral_operations (
  operation_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL
) STRICT;
CREATE TRIGGER corral_operations_no_update BEFORE UPDATE ON corral_operations
BEGIN SELECT RAISE(ABORT, 'corral_operations rows are immutable'); END;
CREATE TRIGGER corral_operations_no_delete BEFORE DELETE ON corral_operations
BEGIN SELECT RAISE(ABORT, 'corral_operations rows are immutable'); END;
`,
};
