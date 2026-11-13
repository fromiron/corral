import { type AgentRole, type CorralDefinition, DEFAULT_LIMITS } from '@corral/contracts';
import {
  type CorralRecord,
  compileDefinition,
  ROLE_PRESET_IDS,
  type RolePresetId,
  roleFromPreset,
} from '@corral/core';
import { describe, expect, it } from 'vitest';
import { connectCapability, type EditorDraft, emptyDraft } from '../src/editor/model.ts';
import { createEditorStore } from '../src/editor/store.ts';
import messages from '../src/messages/en.json' with { type: 'json' };
import { type EditResult, importRole, patchNode, placeStep } from '../src/team-editor/commands.ts';

// Copying a role onto an agent (docs/specs/features/canvas.md, 역할 가져오기): a copy under a
// new role id, never a link to where it came from.

function ok(result: EditResult): { draft: EditorDraft; nodeId: string } {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return { draft: result.draft, nodeId: result.nodeId ?? '' };
}
const refused = (result: EditResult) => (result.ok ? 'accepted' : result.reason);
const agent = (draft: EditorDraft, id: string) => {
  const found = draft.definition.nodes.find((n) => n.id === id);
  if (found?.type !== 'agent' || found.invocation === 'observer')
    throw new Error(`${id} is not a working agent`);
  return found;
};
const roleOf = (draft: EditorDraft, id: string) =>
  draft.definition.roles.find((r) => r.id === agent(draft, id).roleId) as AgentRole;
const wiring = (draft: EditorDraft) =>
  draft.definition.controlEdges
    .map((e) => `${e.source}.${e.sourcePort}>${e.target}.${e.targetPort}`)
    .sort();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** A saved team of the project with a "Review" role, as the repository hands it out. */
function savedTeam(): CorralRecord {
  const definition: CorralDefinition = {
    schemaVersion: '0.1',
    id: 'team_t',
    name: 'T',
    entryNodeId: 'reviewer',
    input: { brief: 'Review the change.', criteria: ['Name the evidence.'] },
    roles: [
      {
        id: 'review',
        name: 'Review',
        prompt: 'Check the change against the criteria.',
        modelProfile: 'model-b',
        reasoning: { mode: 'fixed', level: 'high' },
        allowedWorkTools: ['write_artifact', 'list_files', 'read_file'],
        allowedCollaborationTools: ['read_artifact', 'submit_result'],
        outputContract: 'review',
        editingMode: 'hashline',
        harness: { profileId: 'careful', revision: 3 },
      },
    ],
    nodes: [
      {
        id: 'reviewer',
        type: 'agent',
        label: 'Review',
        roleId: 'review',
        invocation: 'scheduled',
        inputBindings: [{ kind: 'run_input', name: 'criteria' }],
        outputName: 'review',
      },
    ],
    controlEdges: [],
    capabilityLinks: [],
    limits: DEFAULT_LIMITS,
  };
  return {
    corralId: 'team_t',
    projectId: 'project_a',
    name: 'T',
    definition,
    definitionRevision: 4,
    definitionHash: 'a'.repeat(64),
    updatedAt: '2026-11-10T00:00:00.000Z',
  };
}
const reviewRole = (record: CorralRecord) => record.definition.roles[0] as AgentRole;

const briefAndCriteria = {
  inputBindings: [
    { kind: 'run_input', name: 'brief' },
    { kind: 'run_input', name: 'criteria' },
  ],
};

/**
 * agent_1 → agent_2 → Output, both agents running agent_1's role, and agent_1 delegating to a
 * callable helper. agent_1 reads the brief and the criteria.
 */
function team(): EditorDraft {
  let { draft } = ok(placeStep(emptyDraft(), 'agent', { kind: 'empty' }));
  draft = patchNode(draft, 'agent_1', briefAndCriteria);
  draft = ok(placeStep(draft, 'agent', { kind: 'after', nodeId: 'agent_1' })).draft;
  draft = ok(placeStep(draft, 'output', { kind: 'after', nodeId: 'agent_2' })).draft;
  draft = patchNode(draft, 'agent_2', { roleId: agent(draft, 'agent_1').roleId });
  const helper = ok(placeStep(draft, 'agent', { kind: 'empty' }));
  draft = patchNode(helper.draft, helper.nodeId, { invocation: 'callable' });
  const linked = connectCapability(draft, 'agent_1', helper.nodeId, 'delegate');
  if (!linked.ok) throw new Error(linked.reason);
  return linked.draft;
}

/** One agent reading the brief and the criteria, then the Output: it compiles with no diagnostic. */
function plainTeam(): EditorDraft {
  let { draft } = ok(placeStep(emptyDraft(), 'agent', { kind: 'empty' }));
  draft = ok(placeStep(draft, 'output', { kind: 'after', nodeId: 'agent_1' })).draft;
  return patchNode(draft, 'agent_1', briefAndCriteria);
}

const preset = (id: RolePresetId) =>
  roleFromPreset(id, id, messages.TeamTemplates.presets[id] as { name: string; duty: string });

describe('importing a role onto the selected agent', () => {
  it('copies the role and keeps the agent: name, inputs, connections and call links', () => {
    const before = team();
    const record = savedTeam();
    const source = reviewRole(record);
    const result = importRole(before, source, ['agent_1'], undefined, {
      resolvesHarness: () => true,
    });
    const { draft, nodeId } = ok(result);
    expect(nodeId).toBe('agent_1');
    const role = roleOf(draft, 'agent_1');
    expect(role).toMatchObject({
      prompt: source.prompt,
      modelProfile: 'model-b',
      reasoning: { mode: 'fixed', level: 'high' },
      allowedWorkTools: source.allowedWorkTools,
      allowedCollaborationTools: source.allowedCollaborationTools,
      outputContract: 'review',
      editingMode: 'hashline',
      harness: { profileId: 'careful', revision: 3 },
    });
    expect(role.id).not.toBe(source.id);
    expect(role.id).not.toBe(agent(before, 'agent_1').roleId);
    const { roleId: _before, ...kept } = agent(before, 'agent_1');
    const { roleId: _after, ...now } = agent(draft, 'agent_1');
    expect(now).toEqual(kept);
    expect(wiring(draft)).toEqual(wiring(before));
    expect(draft.definition.capabilityLinks).toEqual(before.definition.capabilityLinks);
  });

  it('leaves another agent that ran the same role as it was', () => {
    const before = team();
    const shared = roleOf(before, 'agent_2');
    const { draft } = ok(importRole(before, reviewRole(savedTeam()), ['agent_1']));
    expect(agent(draft, 'agent_2')).toEqual(agent(before, 'agent_2'));
    expect(roleOf(draft, 'agent_2')).toEqual(shared);
  });

  it('drops the previous role when no agent runs it any more, as removing its agent does', () => {
    const before = plainTeam();
    const previous = agent(before, 'agent_1').roleId;
    const owned = { ...before.definition, planOwnerRoleId: previous };
    const { draft } = ok(
      importRole({ ...before, definition: owned }, reviewRole(savedTeam()), ['agent_1']),
    );
    expect(draft.definition.roles.map((r) => r.id)).not.toContain(previous);
    expect(draft.definition.roles).toHaveLength(1);
    expect(draft.definition.planOwnerRoleId).toBeUndefined();
  });

  it('gives every import its own role id', () => {
    const source = reviewRole(savedTeam());
    const first = ok(importRole(team(), source, ['agent_1'])).draft;
    const second = ok(importRole(first, source, ['agent_2'])).draft;
    const again = ok(importRole(second, source, ['agent_1'])).draft;
    const ids = [roleOf(first, 'agent_1').id, roleOf(second, 'agent_2').id];
    expect(new Set(ids).size).toBe(2);
    expect(roleOf(again, 'agent_1').id).not.toBe(ids[0]);
    expect(new Set(again.definition.roles.map((r) => r.id)).size).toBe(
      again.definition.roles.length,
    );
  });

  it('copies a role onto a callable agent too', () => {
    const draft = team();
    const helper = draft.definition.nodes.find(
      (n) => n.type === 'agent' && n.invocation === 'callable',
    ) as { id: string };
    const { draft: next } = ok(importRole(draft, preset('research'), [helper.id]));
    expect(roleOf(next, helper.id).outputContract).toBe('notes');
  });

  it('refuses anything but one agent', () => {
    const draft = team();
    const source = reviewRole(savedTeam());
    expect(refused(importRole(draft, source, ['agent_1', 'agent_2']))).toBe('roleNeedsAgent');
    const output = draft.definition.nodes.find((n) => n.type === 'output') as { id: string };
    expect(refused(importRole(draft, source, [output.id]))).toBe('roleNeedsAgent');
  });

  it('is one undo step that brings the previous role back exactly', () => {
    const before = team();
    const editor = createEditorStore(before);
    editor
      .getState()
      .applyDraft(ok(importRole(before, reviewRole(savedTeam()), ['agent_1'])).draft);
    expect(editor.getState().canUndo).toBe(true);
    editor.getState().undo();
    expect(editor.getState().draft).toBe(before);
    expect(editor.getState().canUndo).toBe(false);
  });
});

describe('importing a role with nothing selected', () => {
  it('adds an agent at the insertion place and names it after the role', () => {
    const before = plainTeam();
    const result = importRole(before, preset('implement'), [], {
      kind: 'after',
      nodeId: 'agent_1',
    });
    const { draft, nodeId } = ok(result);
    expect(nodeId).not.toBe('agent_1');
    expect(agent(draft, nodeId).label).toBe('Implementation');
    expect(roleOf(draft, nodeId)).toMatchObject({
      name: 'Implementation',
      outputContract: 'draft',
      allowedWorkTools: preset('implement').allowedWorkTools,
    });
    expect(wiring(draft)).toContain(`agent_1.out>${nodeId}.in`);
    // The new agent's own default role is not left behind.
    const used = new Set(
      draft.definition.nodes.flatMap((n) => (n.type === 'agent' ? [n.roleId] : [])),
    );
    expect(draft.definition.roles.every((r) => used.has(r.id))).toBe(true);
  });
});

describe('the source of an imported role', () => {
  it('is only read: the saved record and its revision stay as they were', () => {
    const record = deepFreeze(savedTeam());
    const snapshot = structuredClone(record);
    ok(importRole(team(), reviewRole(record), ['agent_1']));
    ok(importRole(team(), reviewRole(record), [], { kind: 'empty' }));
    expect(record).toEqual(snapshot);
    expect(record.definitionRevision).toBe(4);
  });

  it('changing the source afterwards does not reach the copy', () => {
    const record = savedTeam();
    const { draft } = ok(importRole(team(), reviewRole(record), ['agent_1']));
    const copied = structuredClone(roleOf(draft, 'agent_1'));
    const source = reviewRole(record);
    source.prompt = 'Something else entirely.';
    source.allowedWorkTools.push('run_command');
    source.allowedCollaborationTools.push('spawn_subagents');
    source.reasoning = { mode: 'auto' };
    if (source.harness) source.harness.revision = 9;
    expect(roleOf(draft, 'agent_1')).toEqual(copied);
  });
});

describe('what an imported role keeps and leaves out', () => {
  it('keeps a model profile this project does not have, and the diagnostic reports it', () => {
    const source = { ...preset('implement'), modelProfile: 'model-z' };
    const { draft, nodeId } = ok(importRole(plainTeam(), source, [], { kind: 'empty' }));
    expect(roleOf(draft, nodeId).modelProfile).toBe('model-z');
    const compiled = compileDefinition(draft.definition, {
      knownModelProfiles: ['model-a', 'model-b'],
    });
    expect(compiled.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'UNKNOWN_MODEL_PROFILE', nodeId }),
    );
  });

  it('leaves out a work style this place cannot resolve and says so', () => {
    const source = reviewRole(savedTeam());
    const dropped = importRole(team(), source, ['agent_1'], undefined, {
      resolvesHarness: () => false,
    });
    if (!dropped.ok) throw new Error(dropped.reason);
    expect(dropped.droppedHarness).toBe(true);
    expect(roleOf(dropped.draft, 'agent_1')).not.toHaveProperty('harness');

    const unresolved = importRole(team(), source, ['agent_1']);
    if (!unresolved.ok) throw new Error(unresolved.reason);
    expect(unresolved.droppedHarness).toBe(true);
    expect(roleOf(unresolved.draft, 'agent_1')).not.toHaveProperty('harness');

    const asked: unknown[] = [];
    const kept = importRole(team(), source, ['agent_1'], undefined, {
      resolvesHarness: (ref) => {
        asked.push(ref);
        return true;
      },
    });
    if (!kept.ok) throw new Error(kept.reason);
    expect(kept.droppedHarness).toBe(false);
    expect(asked).toEqual([{ profileId: 'careful', revision: 3 }]);

    const none = importRole(team(), preset('plan'), ['agent_1']);
    if (!none.ok) throw new Error(none.reason);
    expect(none.droppedHarness).toBe(false);
  });

  it('does not carry over what only the previous role had', () => {
    let draft = plainTeam();
    const previous = agent(draft, 'agent_1').roleId;
    draft = {
      ...draft,
      definition: {
        ...draft.definition,
        roles: draft.definition.roles.map((r) =>
          r.id === previous
            ? {
                ...r,
                reasoning: { mode: 'auto' },
                harness: { profileId: 'old', revision: 1 },
                imageProfile: 'image-a',
                allowedWorkTools: [...r.allowedWorkTools, 'generate_image'],
              }
            : r,
        ),
      },
    };
    const { draft: next } = ok(importRole(draft, preset('plan'), ['agent_1']));
    const role = roleOf(next, 'agent_1');
    expect(role).not.toHaveProperty('reasoning');
    expect(role).not.toHaveProperty('harness');
    expect(role).not.toHaveProperty('imageProfile');
    expect(role.allowedWorkTools).toEqual(preset('plan').allowedWorkTools);
  });

  it('keeps the inputs of an agent that becomes a reviewer; the reviewer warning says what is missing', () => {
    let draft = plainTeam();
    draft = patchNode(draft, 'agent_1', { inputBindings: [{ kind: 'run_input', name: 'brief' }] });
    const { draft: next } = ok(importRole(draft, preset('review'), ['agent_1']));
    expect(agent(next, 'agent_1').inputBindings).toEqual([{ kind: 'run_input', name: 'brief' }]);
    expect(compileDefinition(next.definition).diagnostics).toEqual([
      expect.objectContaining({ code: 'REVIEW_WITHOUT_CRITERIA', nodeId: 'agent_1' }),
    ]);
  });

  it.each(ROLE_PRESET_IDS)('the %s preset in a valid team still compiles strictly', (id) => {
    const before = plainTeam();
    expect(compileDefinition(before.definition).diagnostics).toEqual([]);
    const onAgent = ok(importRole(before, preset(id), ['agent_1'])).draft;
    const compiled = compileDefinition(onAgent.definition);
    expect(compiled.ok).toBe(true);
    expect(compiled.diagnostics).toEqual([]);
    const placed = ok(
      importRole(before, preset(id), [], { kind: 'after', nodeId: 'agent_1' }),
    ).draft;
    expect(compileDefinition(placed.definition).ok).toBe(true);
  });

  it.each(ROLE_PRESET_IDS)(
    'the %s preset reports only an unresolved model or a call link its tools lack',
    (id) => {
      const { draft } = ok(importRole(team(), preset(id), ['agent_1']));
      const codes = compileDefinition(draft.definition, {
        knownModelProfiles: ['model-a'],
      }).diagnostics.map((d) => d.code);
      const before = new Set(
        compileDefinition(team().definition, { knownModelProfiles: ['model-a'] }).diagnostics.map(
          (d) => d.code,
        ),
      );
      const added = new Set(codes.filter((code) => !before.has(code)));
      for (const code of added)
        expect(['UNKNOWN_MODEL_PROFILE', 'CAPABILITY_NOT_ALLOWED']).toContain(code);
      // The presets have no delegation tool, so the kept delegate link is reported.
      expect(codes).toContain('CAPABILITY_NOT_ALLOWED');
      if (preset(id).modelProfile !== 'model-a') expect(codes).toContain('UNKNOWN_MODEL_PROFILE');
    },
  );
});
