import { FakeClock } from '@corral/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { type Db, openDatabase } from '../src/database.ts';
import { SqliteHarnessStore } from '../src/harness-store.ts';

const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const profile = {
  name: 'Writing',
  policy: 'strict' as const,
  allowedTools: [],
  resources: [],
  startupCommands: [],
};
function setup() {
  const db = openDatabase(':memory:');
  databases.push(db);
  return { db, store: new SqliteHarnessStore(db, new FakeClock()) };
}

describe('immutable harness revisions (H3)', () => {
  it('stores a new revision without changing a bound old revision, including after reopening the repository', () => {
    const { db, store } = setup();
    const first = store.saveProfile('writing', 0, profile);
    const second = store.saveProfile('writing', 1, { ...profile, name: 'Revised writing' });
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    const reopened = new SqliteHarnessStore(db, new FakeClock());
    expect(reopened.getProfile({ profileId: 'writing', revision: 1 })).toEqual(first);
    expect(reopened.listProfiles()).toEqual([second]);
  });

  it('stale saves and direct SQL mutation cannot overwrite a revision', () => {
    const { db, store } = setup();
    store.saveProfile('writing', 0, profile);
    expect(() => store.saveProfile('writing', 0, profile)).toThrow(/revision/i);
    expect(() =>
      db.prepare('UPDATE harness_profile_revisions SET profile_json = ?').run('{}'),
    ).toThrow(/immutable/i);
    expect(() => db.exec('DELETE FROM harness_profile_revisions')).toThrow(/immutable/i);
    expect(store.getProfile({ profileId: 'writing', revision: 1 })?.name).toBe('Writing');
  });

  it('defaults point to exact revisions and are independently guarded against stale changes', () => {
    const { store } = setup();
    store.saveProfile('writing', 0, profile);
    const binding = { profileId: 'writing', revision: 1 };
    expect(store.setDefault('personal', 'default', 0, binding).revision).toBe(1);
    expect(store.getDefault('personal', 'default')).toMatchObject({ binding, revision: 1 });
    expect(() => store.setDefault('personal', 'default', 0, null)).toThrow(/revision/i);
    expect(() => store.setDefault('project', 'default', 0, { ...binding, revision: 99 })).toThrow(
      /profile/i,
    );
    expect(store.setDefault('personal', 'default', 1, null).binding).toBeNull();
  });
});
