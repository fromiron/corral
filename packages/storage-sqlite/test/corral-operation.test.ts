import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorralDefinition } from '@corral/contracts';
import type { SaveRequest } from '@corral/core';
import { FakeClock } from '@corral/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import { type Db, openDatabase, SqliteCorralRepository } from '../src/index.ts';

const directories: string[] = [];
const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});
function open(path = ':memory:') {
  const db = openDatabase(path);
  databases.push(db);
  const repository = new SqliteCorralRepository(db, {
    clock: new FakeClock(),
    newCorralId: () => 'corral_operation_test',
  });
  return { db, repository };
}
async function initial(repository: SqliteCorralRepository): Promise<SaveRequest> {
  const created = await repository.save({
    definition: CorralDefinition.parse(researchTeam),
    layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
    expectedDefinitionRevision: null,
  });
  if (!created.ok) throw new Error(created.message);
  return {
    definition: { ...created.record.definition, name: 'Imported agent definition' },
    layout: created.record.layout,
    expectedDefinitionRevision: 1,
  };
}

describe('durable Corral import receipts', () => {
  it('recovers a committed save after reopening before the caller journal is updated', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'corral-operation-'));
    directories.push(directory);
    const file = join(directory, 'workspace.db');
    const first = open(file);
    const request = await initial(first.repository);
    const saved = await first.repository.saveOperation(request, 'import-1', 1);
    expect(saved.ok && saved.record.definitionRevision).toBe(2);
    first.db.close();

    const reopened = open(file);
    expect(await reopened.repository.operationReceipt('import-1')).toEqual(saved);
    expect(await reopened.repository.saveOperation(request, 'import-1', 1)).toEqual(saved);
    expect((await reopened.repository.get(request.definition.id))?.definitionRevision).toBe(2);
    expect(reopened.repository.getDefinition(request.definition.id, 3)).toBeNull();
    expect(await reopened.repository.operationReceipt('unknown')).toBeNull();
  });

  it('rejects operation ID reuse with a different request or layout guard', async () => {
    const { repository } = open();
    const request = await initial(repository);
    const saved = await repository.saveOperation(request, 'import-1', 1);
    const different = {
      ...request,
      definition: { ...request.definition, name: 'A different import' },
    };
    expect(await repository.saveOperation(different, 'import-1', 1)).toMatchObject({
      ok: false,
      error: 'revision_conflict',
    });
    expect(await repository.saveOperation(request, 'import-1', 2)).toMatchObject({
      ok: false,
      error: 'revision_conflict',
    });
    expect(await repository.operationReceipt('import-1')).toEqual(saved);
    expect((await repository.get(request.definition.id))?.name).toBe(request.definition.name);
  });

  it('refuses an intervening layout-only edit without overwriting it', async () => {
    const { repository } = open();
    const request = await initial(repository);
    const current = await repository.get(request.definition.id);
    if (!current) throw new Error('Missing initial Corral');
    await repository.save({
      definition: current.definition,
      expectedDefinitionRevision: 1,
      layout: { ...current.layout, viewport: { x: 30, y: 40, zoom: 2 } },
    });
    const refused = await repository.saveOperation(request, 'stale-layout', 1);
    expect(refused).toMatchObject({ ok: false, error: 'revision_conflict' });
    expect(await repository.operationReceipt('stale-layout')).toEqual(refused);
    expect(await repository.get(request.definition.id)).toMatchObject({
      definitionRevision: 1,
      layoutRevision: 2,
      layout: { viewport: { x: 30, y: 40, zoom: 2 } },
    });
  });

  it('retains the definition revision guard as well as the layout guard', async () => {
    const { repository } = open();
    const request = await initial(repository);
    await repository.save(request);
    expect(await repository.saveOperation(request, 'stale-definition', 1)).toMatchObject({
      ok: false,
      error: 'revision_conflict',
    });
    expect((await repository.get(request.definition.id))?.definitionRevision).toBe(2);
  });

  it('does not create a new Corral or apply an operation to a missing Corral', async () => {
    const { repository } = open();
    const request = await initial(repository);
    expect(
      await repository.saveOperation(
        { ...request, expectedDefinitionRevision: null },
        'invalid-create',
        1,
      ),
    ).toMatchObject({ ok: false, error: 'revision_conflict' });
    expect(
      await repository.saveOperation(
        { ...request, definition: { ...request.definition, id: 'corral_missing' } },
        'missing-corral',
        1,
      ),
    ).toMatchObject({ ok: false, error: 'not_found' });
    expect(await repository.list()).toHaveLength(1);
    expect((await repository.get(request.definition.id))?.definitionRevision).toBe(1);
  });

  it('rolls back the saved revision when its receipt cannot be committed', async () => {
    const { db, repository } = open();
    const request = await initial(repository);
    db.exec(`CREATE TRIGGER reject_operation BEFORE INSERT ON corral_operations
      BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END;`);
    await expect(repository.saveOperation(request, 'import-1', 1)).rejects.toThrow(
      'receipt unavailable',
    );
    expect((await repository.get(request.definition.id))?.definitionRevision).toBe(1);
    expect(repository.getDefinition(request.definition.id, 2)).toBeNull();
    expect(await repository.operationReceipt('import-1')).toBeNull();
  });
});
