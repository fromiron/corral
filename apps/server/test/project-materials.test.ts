import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ProjectClones } from '../src/projects/clones.ts';
import { ProjectMaterials } from '../src/projects/materials.ts';
import { materialsVaultAdapters } from '../src/projects/vault.ts';

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), 'corral-project-test-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
  ['instructions', 'archived'],
  ['instructions', 'removed'],
  ['memory', 'archived'],
  ['memory', 'removed'],
] as const)(
  '%s import refuses a project %s after preview without writing documents',
  async (kind, state) => {
    const store = new ProjectMaterials(temp());
    let projects = [
      {
        projectId: 'project_a',
        name: 'A',
        description: '',
        revision: 1,
        createdAt: '',
        updatedAt: '',
        archivedAt: null as string | null,
      },
    ];
    const adapter = materialsVaultAdapters(store, { listProjects: async () => projects })[kind];
    const before = await adapter.capture();
    const preview = await adapter.preview(
      {
        documents: [
          { id: 'material_import', projectId: 'source', name: 'Rules', text: 'Imported' },
        ],
      },
      { 'project:source': 'project_a' },
    );
    projects =
      state === 'removed'
        ? []
        : projects.map((project) => ({ ...project, archivedAt: '2026-10-21T00:00:00Z' }));
    await expect(adapter.apply(preview.value, before.revision, 'apply_stale')).rejects.toThrow(
      /active local project/,
    );
    expect(await adapter.capture()).toEqual(before);
    expect(await adapter.receipt?.('apply_stale')).toBeNull();
  },
);

it('material vault apply and rollback append versions with explicit project binding', async () => {
  const root = temp();
  const store = new ProjectMaterials(root);
  const original = store.save('project_a', {
    kind: 'instructions',
    name: 'Rules',
    text: 'Original',
  });
  const originalAttachment = store.attachment('project_a', original.id, 1);
  store.save('project_a', {
    kind: 'instructions',
    name: 'Keep this document',
    text: 'Unrelated material',
  });
  let archivedAt: string | null = null;
  const repository = {
    listProjects: async () => [
      {
        projectId: 'project_a',
        name: 'A',
        description: '',
        revision: 1,
        createdAt: '',
        updatedAt: '',
        archivedAt,
      },
    ],
  };
  const adapter = materialsVaultAdapters(store, repository).instructions;
  const before = await adapter.capture();
  const incoming = {
    documents: [{ id: original.id, projectId: 'source', name: 'Rules', text: 'Imported' }],
  };
  await expect(adapter.preview(incoming, {})).rejects.toThrow(/Choose/);
  const preview = await adapter.preview(incoming, { 'project:source': 'project_a' });
  const applied = await adapter.apply(preview.value, before.revision, 'apply_a');
  archivedAt = '2026-10-21T00:00:00Z';
  expect(await adapter.apply(preview.value, before.revision, 'apply_a')).toEqual(applied);
  await expect(adapter.apply({ documents: [] }, before.revision, 'apply_a')).rejects.toThrow(
    'reused',
  );
  archivedAt = null;
  expect(store.list('project_a')[0]?.text).toBe('Imported');
  expect(store.list('project_a').map((item) => item.text)).toContain('Unrelated material');
  const restored = await adapter.restore(before, applied.revision, 'restore_a');
  expect(store.list('project_a')[0]?.text).toBe('Original');
  expect(store.attachment('project_a', original.id, 1)).toEqual(originalAttachment);
  const restarted = materialsVaultAdapters(new ProjectMaterials(root), repository).instructions;
  expect(await restarted.receipt?.('apply_a')).toEqual(applied);
  expect(await restarted.receipt?.('restore_a')).toEqual(restored);
  expect(await restarted.receipt?.('never_applied')).toBeNull();
  expect(await restarted.restore(before, applied.revision, 'restore_a')).toEqual(restored);
});

it('explicit material snapshots survive edit, deletion and restart', () => {
  const root = temp();
  const store = new ProjectMaterials(root);
  const first = store.save('project_a', {
    name: 'Instructions',
    kind: 'instructions',
    text: 'Read carefully',
  });
  const snapshot = store.attachment('project_a', first.id, 1);
  expect(snapshot.text).toBe('Read carefully');
  expect(() => store.save('project_a', { ...first, text: 'stale', expectedRevision: 0 })).toThrow();
  store.save('project_a', { ...first, text: 'Updated', expectedRevision: 1 });
  store.remove('project_a', first.id, 2);
  expect(store.list('project_a')).toEqual([]);
  expect(new ProjectMaterials(root).attachment('project_a', first.id, 1)).toEqual(snapshot);
  expect(() => store.attachment('project_b', first.id, 1)).toThrow();
});

it('actual clone refuses overwrite and stays separate from project trust', async () => {
  const root = temp();
  const source = temp();
  execFileSync('git', ['init', '-q'], { cwd: source });
  writeFileSync(join(source, 'hello.txt'), 'hello\n');
  execFileSync('git', ['add', '.'], { cwd: source });
  execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'],
    { cwd: source },
  );
  const store = new ProjectClones(root);
  const destination = join(root, 'checkout');
  const started = store.start({ commandId: 'clone_test', source, destination });
  expect(store.start({ commandId: 'clone_test', source, destination }).id).toBe(started.id);
  const completed = await store.wait(started.id);
  expect(completed.state).toBe('completed');
  expect(completed.cleanupConfirmed).toBe(true);
  expect(readFileSync(join(destination, 'hello.txt'), 'utf8')).toBe('hello\n');
  expect(() => store.start({ commandId: 'clone_other', source, destination })).toThrow(/exists/);
  expect(existsSync(join(destination, '.git'))).toBe(true);
}, 30000);

it('URL credentials are refused before any destination is created', () => {
  const root = temp();
  const store = new ProjectClones(root);
  const destination = join(root, 'checkout');
  expect(() =>
    store.start({ commandId: 'bad', source: 'https://user:secret@example.com/repo', destination }),
  ).toThrow(/credential/);
  expect(existsSync(destination)).toBe(false);
});

it('an empty repository clones without creating an initial commit', async () => {
  const root = temp();
  const source = temp();
  execFileSync('git', ['init', '-q'], { cwd: source });
  const store = new ProjectClones(root);
  const destination = join(root, 'empty');
  const op = store.start({ commandId: 'empty_clone', source, destination });
  expect((await store.wait(op.id)).state).toBe('completed');
  expect(() =>
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: destination, stdio: 'pipe' }),
  ).toThrow();
}, 30000);

it('cancellation confirms process cleanup before removing only its partial directory', async () => {
  const root = temp();
  const source = temp();
  execFileSync('git', ['init', '-q'], { cwd: source });
  const store = new ProjectClones(root);
  const destination = join(root, 'partial');
  const started = store.start({ commandId: 'cancel_test', source, destination });
  expect(() =>
    store.start({ commandId: 'cancel_test', source, destination: join(root, 'other') }),
  ).toThrow();
  store.cancel(started.id);
  const cancelled = await store.wait(started.id);
  expect(cancelled.state).toBe('cancelled');
  expect(cancelled.cleanupConfirmed).toBe(true);
  expect(existsSync(destination)).toBe(true);
  await store.removePartial(started.id);
  expect(existsSync(destination)).toBe(false);
}, 30000);
