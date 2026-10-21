export const PACKAGE_MIGRATION = {
  name: '0025_harness_packages',
  sql: `
CREATE TABLE harness_package_management (
  hash TEXT PRIMARY KEY REFERENCES harness_resources(hash),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled', 'removed')),
  updated_at TEXT NOT NULL
);
`,
};
