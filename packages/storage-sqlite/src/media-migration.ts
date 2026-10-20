/** Ready blobs precede the canonical artifact event; orphan cleanup consults that event. */
export const MEDIA_ARTIFACT_MIGRATION = {
  name: '0024_generated_media',
  sql: `CREATE TABLE generated_media (
    run_id TEXT NOT NULL REFERENCES runs(id),
    version_id TEXT NOT NULL,
    effect_id TEXT NOT NULL,
    owner_json TEXT NOT NULL,
    descriptor_json TEXT NOT NULL,
    body BLOB NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(run_id, version_id),
    UNIQUE(run_id, effect_id)
  ) STRICT;
  CREATE TRIGGER generated_media_immutable_update BEFORE UPDATE ON generated_media
    BEGIN SELECT RAISE(ABORT,'generated media is immutable'); END;
  CREATE TABLE image_generation_operations (
    run_id TEXT NOT NULL REFERENCES runs(id),
    effect_id TEXT NOT NULL,
    identity_hash TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('running','completed','unknown')),
    result_json TEXT,
    PRIMARY KEY(run_id,effect_id)
  ) STRICT;
  CREATE TABLE image_generation_profiles (
    profile_id TEXT PRIMARY KEY, config_json TEXT NOT NULL
  ) STRICT;`,
};
