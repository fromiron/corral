import { CorralDefinition } from '@corral/contracts';
import { FakeClock, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import {
  createKeyValueAgentLibrary,
  createKeyValueCorralRepository,
  definitionHash,
  type KeyValueStore,
  planSave,
} from '../src/index.ts';
import {
  describeAgentLibraryContract,
  describeCorralRepositoryContract,
} from '../src/testing/index.ts';

class MapStore implements KeyValueStore {
  readonly data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const team = () => CorralDefinition.parse(researchTeam);

function setup() {
  const store = new MapStore();
  const ids = new SequentialIdFactory();
  const repo = createKeyValueCorralRepository(store, {
    clock: new FakeClock(),
    newCorralId: () => ids.next('run').replace('run', 'corral'),
  });
  return { store, repo };
}

describeCorralRepositoryContract('key-value (browser)', () => setup().repo);

it('stable creation retries an interrupted first save without reporting an unlisted team', async () => {
  const { repo, store } = setup();
  const createId = 'corral_0001';
  const request = {
    createId,
    definition: { ...team(), id: createId },
    expectedDefinitionRevision: null,
  };
  const setItem = store.setItem.bind(store);
  store.setItem = (key, value) => {
    if (key === 'corral:v1:index') throw new Error('quota exceeded');
    setItem(key, value);
  };
  expect(await repo.save(request)).toMatchObject({ ok: false, error: 'storage_unavailable' });
  expect(await repo.get(createId)).toBeNull();
  store.setItem = setItem;
  const saved = await repo.save(request);
  expect(saved).toMatchObject({ ok: true, changed: { definition: true } });
  expect((await repo.list()).map((team) => team.corralId)).toEqual([createId]);
  expect(await repo.getRevision(createId, 1)).toEqual(request.definition);
});

describe('planSave stable creation', () => {
  const createId = 'corral_editor-draft';
  const definition = { ...team(), id: createId };
  const request = { definition, createId, expectedDefinitionRevision: null };
  const now = '2026-11-01T00:00:00.000Z';
  const original = {
    corralId: createId,
    projectId: 'default',
    name: definition.name,
    definition,
    definitionHash: definitionHash(definition),
    definitionRevision: 1,
    updatedAt: now,
  };
  const edited = { ...definition, name: 'Edited later' };
  const current = {
    ...original,
    name: edited.name,
    definition: edited,
    definitionHash: definitionHash(edited),
    definitionRevision: 2,
    updatedAt: '2026-11-02T00:00:00.000Z',
  };
  const invalid = { ok: false, error: 'validation_error' };
  const conflict = { ok: false, error: 'revision_conflict' };
  const replay = { ok: true, record: current, changed: { definition: false } };

  it.each([
    {
      label: 'new id',
      saved: null,
      input: request,
      expected: { ok: true, record: original, changed: { definition: true } },
    },
    { label: 'exact replay after edit', saved: current, input: request, expected: replay },
    {
      label: 'different first definition even when it matches the current one',
      saved: current,
      input: { ...request, definition: edited },
      expected: conflict,
    },
    {
      label: 'foreign project',
      saved: original,
      input: { ...request, projectId: 'other' },
      expected: conflict,
    },
    ...['role_draft', 'corral_', 'corral_a/b', `corral_${'x'.repeat(114)}`].map((id) => ({
      label: `malformed team id: ${id}`,
      saved: null,
      input: { ...request, definition: { ...definition, id }, createId: id },
      expected: invalid,
    })),
    {
      label: 'definition id mismatch',
      saved: null,
      input: { ...request, createId: 'corral_other' },
      expected: invalid,
    },
    {
      label: 'createId on an edit',
      saved: original,
      input: { ...request, expectedDefinitionRevision: 1 },
      expected: invalid,
    },
    {
      label: 'no createId allocates another id even for a known definition',
      saved: current,
      input: { definition, expectedDefinitionRevision: null },
      expected: {
        ok: true,
        record: { corralId: 'corral_allocated', definitionRevision: 1 },
        changed: { definition: true },
      },
    },
  ])('$label', ({ saved, input, expected }) => {
    const result = planSave(saved, input, {
      now,
      newCorralId: () => 'corral_allocated',
      firstDefinitionHash: () => original.definitionHash,
    });
    expect(result).toMatchObject(expected);
  });
});

function librarySetup() {
  const { store, repo: projects } = setup();
  const clock = new FakeClock();
  let id = 0;
  const options = { clock, projects, newAgentId: () => `agent_${++id}` };
  return { agents: createKeyValueAgentLibrary(store, options), store, options, clock, projects };
}

describeAgentLibraryContract('key-value (browser)', librarySetup);

it('keeps originals on the same browser store across instances and refuses broken data', async () => {
  const { agents, store, options } = librarySetup();
  const role = {
    name: 'Author',
    prompt: 'Write.',
    modelProfile: 'model-a',
    outputContract: 'draft' as const,
    allowedWorkTools: [],
    allowedCollaborationTools: [],
  };
  const input = { role, operationId: 'create' };
  const first = await agents.create('default', input);
  if (!first.ok) throw new Error(first.message);
  const other = createKeyValueAgentLibrary(store, options);
  expect(await other.create('default', input)).toEqual(first);
  expect(await other.get('default', first.agent.agentId)).toEqual(first.agent);
  const isolated = createKeyValueAgentLibrary(new MapStore(), options);
  expect(await isolated.list('default')).toEqual([]);

  const [key] = [...store.data.keys()].filter((k) => k.startsWith('corral:v1:agent'));
  if (!key) throw new Error('missing project library');
  store.setItem(key, '{broken JSON with private text');
  await expect(other.list('default')).rejects.toThrow('cannot be read');
  await expect(other.get('default', first.agent.agentId)).rejects.toThrow('cannot be read');
  expect(await other.create('default', input)).toMatchObject({
    ok: false,
    error: 'storage_unavailable',
  });
  expect(store.getItem(key)).toBe('{broken JSON with private text');
});

describe('key-value corral repository', () => {
  it('a failed storage write preserves the pending title and retry records one request', async () => {
    const { store, repo } = setup();
    const created = await repo.createSession({
      projectId: 'default',
      title: 'New session',
      autoTitle: true,
    });
    if (!created.ok) throw new Error(created.message);
    const originalWrite = store.setItem.bind(store);
    store.setItem = () => {
      throw new Error('storage is full');
    };
    const entry = {
      intent: 'next' as const,
      text: 'Persist this title atomically',
      state: 'started' as const,
      commandId: 'title_retry',
    };
    const failed = await repo.addSessionEntry(created.session.sessionId, entry);
    expect(failed).toMatchObject({ ok: false, error: 'storage_unavailable' });
    expect(await repo.getSession(created.session.sessionId)).toMatchObject({
      title: 'New session',
      autoTitle: true,
      entries: [],
    });
    store.setItem = originalWrite;
    const saved = await repo.addSessionEntry(created.session.sessionId, entry);
    expect(saved.ok && saved.session.title).toBe(entry.text);
    await repo.addSessionEntry(created.session.sessionId, entry);
    expect((await repo.getSession(created.session.sessionId))?.entries).toHaveLength(1);
  });

  it('refuses stored data it cannot read instead of guessing', async () => {
    const { store, repo } = setup();
    const created = await repo.save({
      definition: team(),
      expectedDefinitionRevision: null,
    });
    if (!created.ok) throw new Error('create failed');
    for (const key of store.data.keys())
      if (key.includes(created.record.corralId)) store.setItem(key, '{"broken":');
    await expect(repo.get(created.record.corralId)).rejects.toThrow(/cannot be read/);
  });
});

it('preserves structured refusal diagnostics when a session is reopened', async () => {
  const { repo } = setup();
  const made = await repo.createSession({ projectId: 'default', title: 'diagnostics' });
  if (!made.ok) throw new Error(made.message);
  const refusal = {
    code: 'RUN_ALREADY_ACTIVE' as const,
    message: 'termination unconfirmed',
    owner: {
      kind: 'terminal' as const,
      id: 'owner',
      sessionId: made.session.sessionId,
      state: 'uncertain' as const,
    },
  };
  const appended = await repo.addSessionEntry(made.session.sessionId, {
    intent: 'next',
    text: 'try',
    state: 'refused',
    detail: refusal.message,
    refusal,
  });
  expect(appended.ok).toBe(true);
  expect((await repo.getSession(made.session.sessionId))?.entries[0]?.refusal).toEqual(refusal);
});

it('reads a session saved before autoStart as starting its queue', async () => {
  const { store, repo } = setup();
  const made = await repo.createSession({ projectId: 'default', title: 'older' });
  if (!made.ok) throw new Error(made.message);
  for (const [key, value] of store.data) {
    if (!value.includes(made.session.sessionId)) continue;
    const sessions = JSON.parse(value) as Record<string, unknown>[];
    store.setItem(key, JSON.stringify(sessions.map(({ autoStart: _drop, ...rest }) => rest)));
  }
  expect(store.data.size).toBeGreaterThan(0);
  expect([...store.data.values()].some((value) => value.includes('autoStart'))).toBe(false);
  expect((await repo.getSession(made.session.sessionId))?.autoStart).toBe(true);
});

it('reads a session saved before the advisor setting as having it off', async () => {
  const { store, repo } = setup();
  const made = await repo.createSession({ projectId: 'default', title: 'older' });
  if (!made.ok) throw new Error(made.message);
  for (const [key, value] of store.data) {
    if (!value.includes(made.session.sessionId)) continue;
    const sessions = JSON.parse(value) as Record<string, unknown>[];
    store.setItem(key, JSON.stringify(sessions.map(({ advisor: _drop, ...rest }) => rest)));
  }
  expect([...store.data.values()].some((value) => value.includes('advisor'))).toBe(false);
  expect((await repo.getSession(made.session.sessionId))?.advisor).toBeNull();
});
