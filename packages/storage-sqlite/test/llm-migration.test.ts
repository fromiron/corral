import { FakeClock, linearCorral } from '@corral/testkit';
import { expect, it } from 'vitest';
import { openDatabase, SqliteCorralRepository } from '../src/index.ts';

it('unlimited migration creates one revision and preserves the original definition', async () => {
  const db = openDatabase(':memory:');
  try {
    const repository = new SqliteCorralRepository(db, {
      clock: new FakeClock(),
      newCorralId: () => 'corral_fixture',
    });
    const definition = linearCorral(['writer']);
    const saved = await repository.save({
      definition,
      layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
      expectedDefinitionRevision: null,
    });
    if (!saved.ok) throw new Error('fixture save failed');
    const id = saved.record.corralId;
    const original = db
      .prepare(
        'SELECT definition_json, definition_hash FROM definition_versions WHERE corral_id=? AND revision=1',
      )
      .get(id);
    await repository.migrateExecutionPolicies();
    await repository.migrateExecutionPolicies();
    expect((await repository.get(id))?.definitionRevision).toBe(2);
    expect((await repository.get(id))?.definition.executionPolicy).toEqual({ version: 2 });
    expect(
      db
        .prepare(
          'SELECT definition_json, definition_hash FROM definition_versions WHERE corral_id=? AND revision=1',
        )
        .get(id),
    ).toEqual(original);
  } finally {
    db.close();
  }
});
