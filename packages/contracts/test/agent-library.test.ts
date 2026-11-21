import { describe, expect, it } from 'vitest';
import { CreateLibraryAgent, LibraryAgent, UpdateLibraryAgent } from '../src/index.ts';

const role = {
  name: 'Writer',
  prompt: 'Write.',
  modelProfile: 'model-a',
  outputContract: 'draft',
  allowedWorkTools: [],
  allowedCollaborationTools: [],
  skills: [],
};

describe('agent library contracts', () => {
  it('includes only reusable role settings in originals and creation requests', () => {
    const body = { role, operationId: 'create_writer' };
    expect(CreateLibraryAgent.parse(body)).toEqual(body);
    for (const extra of [
      { id: 'writer' },
      { origin: { kind: 'preset', presetId: 'writer' } },
      { stepInstruction: 'Team only' },
    ]) {
      expect(CreateLibraryAgent.safeParse({ ...body, role: { ...role, ...extra } }).success).toBe(
        false,
      );
    }
    expect(CreateLibraryAgent.safeParse({ ...body, operationId: 'bad id' }).success).toBe(false);
    expect(CreateLibraryAgent.safeParse({ ...body, projectId: 'elsewhere' }).success).toBe(false);
    const record = {
      agentId: 'agent_1',
      projectId: 'default',
      revision: 1,
      role,
      createdAt: '2026-11-19T00:00:00Z',
      updatedAt: '2026-11-19T00:00:00Z',
      archivedAt: null,
    };
    expect(LibraryAgent.parse(record)).toEqual(record);
    expect(LibraryAgent.safeParse({ ...record, revision: 0 }).success).toBe(false);
    expect(LibraryAgent.safeParse({ ...record, operationId: 'internal' }).success).toBe(false);
  });

  it('keeps the description of a saved agent', () => {
    const described = { ...role, description: 'Writes the summary. Use it after research.' };
    const body = { role: described, operationId: 'create_writer' };
    expect(CreateLibraryAgent.parse(body)).toEqual(body);
    expect(UpdateLibraryAgent.parse({ role: described, expectedRevision: 1 }).role).toEqual(
      described,
    );
    expect(
      CreateLibraryAgent.safeParse({ ...body, role: { ...role, description: '' } }).success,
    ).toBe(false);
  });

  it('requires a revision and at least one mutation, including restore', () => {
    for (const body of [
      { expectedRevision: 1 },
      { archived: false },
      { expectedRevision: 0, role },
      { expectedRevision: 1, role, unknown: true },
    ]) {
      expect(UpdateLibraryAgent.safeParse(body).success).toBe(false);
    }
    for (const patch of [{ role }, { archived: false }, { role, archived: true }]) {
      expect(UpdateLibraryAgent.safeParse({ expectedRevision: 1, ...patch }).success).toBe(true);
    }
  });
});
