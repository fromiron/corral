import { type CorralDefinition, DEFAULT_LIMITS } from '@corral/contracts';
import { type Db, openDatabase, SqliteCorralRepository } from '@corral/storage-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createSubagentsVaultAdapter } from '../src/vault/subagents.ts';

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
async function setup() {
  const db = openDatabase(':memory:');
  opened.push(db);
  const repository = new SqliteCorralRepository(db, {
    clock: { nowIso: () => '2026-10-20T00:00:00.000Z', monotonicMs: () => 0 },
    newCorralId: () => 'target',
  });
  const definition: CorralDefinition = {
    schemaVersion: '0.1',
    id: 'target',
    name: 'Target',
    entryNodeId: 'parent',
    input: { brief: 'Keep this brief', criteria: ['Keep this criterion'] },
    limits: DEFAULT_LIMITS,
    roles: [
      {
        id: 'owner',
        name: 'Owner',
        prompt: 'Work',
        modelProfile: 'local',
        allowedWorkTools: ['write_artifact', 'read_file'],
        allowedCollaborationTools: ['submit_result'],
        outputContract: 'text',
      },
    ],
    nodes: [
      {
        id: 'parent',
        type: 'agent',
        label: 'Parent',
        roleId: 'owner',
        invocation: 'scheduled',
        inputBindings: [],
        outputName: 'answer',
      },
    ],
    controlEdges: [],
    capabilityLinks: [],
  };
  const saved = await repository.save({
    definition,
    layout: { nodes: { parent: { x: 0, y: 0 } }, viewport: { x: 0, y: 0, zoom: 1 } },
    expectedDefinitionRevision: null,
  });
  if (!saved.ok) throw new Error(saved.message);
  const adapter = createSubagentsVaultAdapter({
    repository,
    corralId: 'target',
    profiles: async () => [{ profileId: 'local', available: true }],
  });
  const before = await adapter.capture();
  const source = {
    version: 1,
    corralId: 'other',
    projectId: 'elsewhere',
    definition: {
      ...definition,
      id: 'other',
      roles: [
        {
          ...definition.roles[0],
          id: 'child_role',
          name: 'Reviewer',
          editingMode: 'hashline' as const,
          allowedCollaborationTools: ['submit_result', 'ask_user', 'update_plan'],
        },
      ],
      nodes: [
        { ...definition.nodes[0], id: 'child', roleId: 'child_role', invocation: 'callable' },
      ],
    },
    layout: { ...saved.record.layout, corralId: 'other' },
  };
  const bindings = {
    corralId: 'target',
    projectId: 'default',
    parentNodeId: 'parent',
    'model:child_role': 'local',
  };
  return { adapter, repository, source, bindings, before, definition };
}

describe('TC-ABS-13 subagents domain owner adapter', () => {
  it('requires explicit local team, parent and model bindings before import', async () => {
    const { adapter, source, bindings } = await setup();
    await expect(adapter.preview(source, {})).rejects.toThrow(/Bind/);
    await expect(adapter.preview(source, { ...bindings, 'model:child_role': '' })).rejects.toThrow(
      /Map the model/,
    );
    await expect(adapter.preview(source, { ...bindings, corralId: 'other' })).rejects.toThrow(
      /Bind/,
    );
    await expect(adapter.preview({ ...source, corralId: 'mismatched' }, bindings)).rejects.toThrow(
      /identity/,
    );
  });
  it('rejects source tools beyond the target parent and allows only explicit exclusion', async () => {
    const { adapter, source, bindings } = await setup();
    source.definition.roles[0]?.allowedWorkTools?.push('write_file');
    await expect(adapter.preview(source, bindings)).rejects.toThrow(/parent capability/);
    await expect(
      adapter.preview(source, { ...bindings, 'tool:child:write_file': 'omit' }),
    ).resolves.toBeDefined();
  });
  it('adds only the callable graph, then restores journaled settings through the repository owner', async () => {
    const { adapter, source, bindings, before, repository, definition } = await setup();
    const preview = await adapter.preview(source, bindings);
    const applied = await adapter.apply(preview.value, before.revision, 'operation-1');
    const current = await repository.get('target');
    expect(current?.definition.input).toEqual(definition.input);
    expect(current?.definition.limits).toEqual(definition.limits);
    expect(current?.definition.nodes).toHaveLength(2);
    expect(current?.definition.capabilityLinks).toHaveLength(1);
    expect(current?.definition.roles.at(-1)?.allowedCollaborationTools).toEqual([
      'submit_result',
      'ask',
    ]);
    expect(current?.definition.roles.at(-1)?.editingMode).toBe('hashline');
    expect(current?.definition.roles[0]?.allowedCollaborationTools).toContain('spawn_subagents');
    await adapter.restore(before, applied.revision, 'rollback-1');
    expect((await repository.get('target'))?.definition).toEqual(definition);
    expect(await adapter.receipt?.('operation-1')).toEqual(applied);
    expect(await adapter.apply(preview.value, before.revision, 'operation-1')).toEqual(applied);
    const restored = await adapter.receipt?.('rollback-1');
    expect(await adapter.restore(before, applied.revision, 'rollback-1')).toEqual(restored);
  });
  it('refuses stale apply/restore rather than overwriting a later team edit', async () => {
    const { adapter, source, bindings, before, repository } = await setup();
    const preview = await adapter.preview(source, bindings);
    const applied = await adapter.apply(preview.value, before.revision, 'operation-1');
    const current = await repository.get('target');
    if (!current) throw new Error('Missing team');
    await repository.save({
      definition: { ...current.definition, name: 'Later edit' },
      layout: current.layout,
      expectedDefinitionRevision: current.definitionRevision,
    });
    await expect(adapter.apply(preview.value, before.revision, 'operation-1')).resolves.toEqual(
      applied,
    );
    await expect(adapter.apply(preview.value, before.revision, 'operation-new')).rejects.toThrow(
      /revision conflict/,
    );
    await expect(adapter.restore(before, applied.revision, 'rollback-1')).rejects.toThrow(
      /revision conflict/,
    );
    expect((await repository.get('target'))?.name).toBe('Later edit');
  });
  it('preserves layout edits made while resolving model bindings', async () => {
    const { adapter, source, bindings, before, repository } = await setup();
    const preview = await adapter.preview(source, bindings);
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const delayed = createSubagentsVaultAdapter({
      repository,
      corralId: 'target',
      profiles: async () => {
        entered();
        await gate;
        return [{ profileId: 'local', available: true }];
      },
    });
    const applying = delayed.apply(preview.value, before.revision, 'operation-layout');
    await waiting;
    const current = await repository.get('target');
    if (!current) throw new Error('Missing team');
    await repository.save({
      definition: current.definition,
      layout: { ...current.layout, nodes: { parent: { x: 900, y: 400 } } },
      expectedDefinitionRevision: current.definitionRevision,
    });
    release();
    await expect(applying).rejects.toThrow(/revision conflict/);
    expect((await repository.get('target'))?.layout.nodes.parent).toEqual({ x: 900, y: 400 });
  });
});
