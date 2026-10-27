import { createKeyValueCorralRepository } from '@corral/core';
import { emptyDraft } from '@corral/react';
import { expect, it } from 'vitest';
import { createFromTemplate } from './templates.ts';

it('names repeated template copies distinctly within their project', async () => {
  const values = new Map<string, string>();
  let id = 0;
  const repository = createKeyValueCorralRepository(
    {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    },
    {
      newCorralId: () => `team_${++id}`,
      clock: { nowIso: () => '2026-10-28T00:00:00.000Z', monotonicMs: () => 0 },
    },
  );
  for (let copy = 0; copy < 3; copy++) {
    expect((await createFromTemplate(repository, 'research-team', 'Untitled')).ok).toBe(true);
  }
  const names = (await repository.list()).map((team) => team.name);
  expect(new Set(names).size).toBe(3);
  expect(names).toEqual(
    expect.arrayContaining(['Research team', 'Research team (2)', 'Research team (3)']),
  );
});

it('new blank and template teams keep their definition revision on reload', async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  let id = 0;
  const options = {
    newCorralId: () => `team_${++id}`,
    clock: { nowIso: () => '2026-10-28T00:00:00.000Z', monotonicMs: () => 0 },
  };
  const repository = createKeyValueCorralRepository(storage, options);
  const blank = emptyDraft();
  await repository.save({
    definition: blank.definition,
    layout: { nodes: blank.layout, viewport: blank.viewport },
    expectedDefinitionRevision: null,
  });
  await createFromTemplate(repository, 'research-team', 'Untitled');
  const before = await repository.list();
  const reloaded = createKeyValueCorralRepository(storage, options);
  expect(await reloaded.list()).toEqual(before);
});
