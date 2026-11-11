// @vitest-environment jsdom
import type { CorralDefinition } from '@corral/contracts';
import { type CorralRepository, createKeyValueCorralRepository } from '@corral/core';
import { addNode, emptyDraft } from '@corral/react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServicesProvider, type StudioServices } from '../services.tsx';
import { useSavedTeams } from './useSavedTeams.ts';

// The saved teams the editor can take roles from (docs/specs/features/canvas.md, 역할 가져오기):
// the other teams of the same project, each at its latest saved revision, only ever read.

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
const roots: (() => void)[] = [];
afterEach(() => {
  for (const unmount of roots.splice(0)) act(() => unmount());
});

type Result = ReturnType<typeof useSavedTeams>;

function renderHook(repository: CorralRepository, corralId: string, projectId: string) {
  const result: { current: Result | null } = { current: null };
  function Probe() {
    result.current = useSavedTeams({ corralId, projectId }, { nodes: [] });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  roots.push(() => root.unmount());
  act(() =>
    root.render(
      <ServicesProvider services={{ repository } as StudioServices}>
        <Probe />
      </ServicesProvider>,
    ),
  );
  return result;
}

async function waitFor(check: () => void) {
  for (let i = 0; ; i++) {
    try {
      check();
      return;
    } catch (error) {
      if (i > 50) throw error;
      await act(async () => new Promise((done) => setTimeout(done, 2)));
    }
  }
}

function memoryRepository(): CorralRepository {
  const memory = new Map<string, string>();
  let n = 0;
  return createKeyValueCorralRepository(
    {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => void memory.set(key, value),
      removeItem: (key) => void memory.delete(key),
    },
    {
      clock: { nowIso: () => '2026-11-11T00:00:00.000Z', monotonicMs: () => 0 },
      newCorralId: () => `corral_${++n}`,
      newProjectId: () => `project_${++n}`,
    },
  );
}

/** A one-agent team whose role is named `role`. */
function oneRole(name: string, role: string): CorralDefinition {
  const { definition } = addNode(emptyDraft(name, name), 'agent').draft;
  return {
    ...definition,
    roles: definition.roles.map((r) => ({ ...r, name: role, prompt: `Do the ${role} part.` })),
  };
}

async function save(repository: CorralRepository, definition: CorralDefinition, projectId: string) {
  const saved = await repository.save({ definition, expectedDefinitionRevision: null, projectId });
  if (!saved.ok) throw new Error(saved.message);
  return saved.record;
}

describe('useSavedTeams: roles to import', () => {
  it('lists the other teams of the project with their saved roles, not the one being edited', async () => {
    const repository = memoryRepository();
    const project = await repository.createProject({ name: 'A' });
    const other = await repository.createProject({ name: 'B' });
    if (!project.ok || !other.ok) throw new Error('no project');
    const projectId = project.project.projectId;
    const editing = await save(repository, oneRole('Editing', 'Lead'), projectId);
    const harbor = await save(repository, oneRole('Harbor', 'Release check'), projectId);
    await save(repository, oneRole('Elsewhere', 'Outsider'), other.project.projectId);
    // A later save is what the list offers.
    const resaved = await repository.save({
      definition: {
        ...harbor.definition,
        roles: harbor.definition.roles.map((r) => ({ ...r, prompt: 'Check the release.' })),
      },
      expectedDefinitionRevision: harbor.definitionRevision,
    });
    if (!resaved.ok) throw new Error(resaved.message);

    const result = renderHook(repository, editing.corralId, projectId);
    await waitFor(() => expect(result.current?.references[0]?.roles).toBeDefined());
    const references = result.current?.references ?? [];
    expect(references.map((team) => team.name)).toEqual(['Harbor']);
    expect(references[0]).toMatchObject({
      corralId: harbor.corralId,
      definitionRevision: 2,
    });
    expect(references[0]?.roles?.map((r) => [r.name, r.prompt])).toEqual([
      ['Release check', 'Check the release.'],
    ]);
  });

  it('only reads the saved teams', async () => {
    const repository = memoryRepository();
    const harbor = await save(repository, oneRole('Harbor', 'Release check'), 'default');
    const editing = await save(repository, oneRole('Editing', 'Lead'), 'default');
    const before = await repository.get(harbor.corralId);
    const calls: string[] = [];
    const watched = new Proxy(repository, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push(String(key));
          return value.apply(target, args);
        };
      },
    });
    const result = renderHook(watched, editing.corralId, 'default');
    await waitFor(() => expect(result.current?.references[0]?.roles).toBeDefined());
    expect(new Set(calls)).toEqual(new Set(['list', 'get']));
    expect(await repository.get(harbor.corralId)).toEqual(before);
  });
});
