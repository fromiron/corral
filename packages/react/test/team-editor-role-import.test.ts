import { type AgentRole, isWorkAgent } from '@corral/contracts';
import {
  compileDefinition,
  ROLE_PRESET_IDS,
  roleFromPreset,
  TEAM_TEMPLATE_ROLES,
  teamTemplate,
} from '@corral/core';
import { describe, expect, it } from 'vitest';
import {
  connectCapability,
  draftFromDefinition,
  type EditorDraft,
  emptyDraft,
  exportDefinition,
  importDefinition,
  updateNode,
} from '../src/editor/model.ts';
import { createEditorStore } from '../src/editor/store.ts';
import messages from '../src/messages/en.json' with { type: 'json' };
import {
  type AgentSource,
  addAgent,
  applyPattern,
  compositionPlacement,
  type EditResult,
  patchNode,
  placeStep,
  previewReplaceAgent,
  replaceAgent,
  seatTask,
  setSeatTask,
  setStepInstruction,
} from '../src/team-editor/commands.ts';

function ok(result: EditResult) {
  if (!result.ok) throw new Error(result.reason);
  return { draft: result.draft, nodeId: result.nodeId ?? '' };
}

const agent = (draft: EditorDraft, id: string) => {
  const found = draft.definition.nodes.find((node) => node.id === id);
  if (!isWorkAgent(found)) throw new Error(`Missing agent: ${id}`);
  return found;
};
const roleOf = (draft: EditorDraft, id: string) =>
  draft.definition.roles.find((role) => role.id === agent(draft, id).roleId) as AgentRole;
const standalone = { kind: 'empty' } as const;
const skill = { resourceHash: 'a'.repeat(64), entry: 'writing/SKILL.md' };
function writer(): AgentSource {
  return {
    role: {
      name: 'Writer',
      prompt: 'Write the announcement.',
      modelProfile: 'model-b',
      outputContract: 'draft',
      allowedWorkTools: ['write_artifact', 'read_file'],
      allowedCollaborationTools: ['submit_result', 'update_plan'],
      reasoning: { mode: 'fixed', level: 'high' },
      editingMode: 'hashline',
      harness: { profileId: 'elsewhere', revision: 3 },
      skills: [skill],
    },
    origin: { kind: 'library', agentId: 'writer', revision: 4 },
    stepInstruction: 'Use a friendly tone.',
  };
}
function flow() {
  const first = ok(placeStep(emptyDraft(), 'agent', standalone));
  return ok(placeStep(first.draft, 'output', { kind: 'after', nodeId: first.nodeId })).draft;
}
function addAtEnd(draft: EditorDraft, source: AgentSource) {
  return ok(addAgent(draft, source, compositionPlacement(draft.definition)));
}

describe('adding a copy to a team', () => {
  it('inserts after a selected seat without editing it or the final result choice', () => {
    const before = flow();
    const source = writer();
    const result = ok(addAgent(before, source, { kind: 'after', nodeId: 'agent_1' }));
    const { draft, nodeId } = result;
    expect(agent(draft, 'agent_1')).toBe(agent(before, 'agent_1'));
    expect(roleOf(draft, 'agent_1')).toBe(roleOf(before, 'agent_1'));
    expect(agent(draft, nodeId)).toMatchObject({
      label: 'Writer',
      stepInstruction: source.stepInstruction,
      inputBindings: [
        { kind: 'run_input', name: 'brief' },
        { kind: 'task_output', sourceNodeId: 'agent_1' },
      ],
    });
    expect(draft.definition.nodes.find((n) => n.type === 'output')).toBe(
      before.definition.nodes.find((n) => n.type === 'output'),
    );
    expect(roleOf(draft, nodeId)).toMatchObject({ ...source.role, origin: source.origin });
    expect(roleOf(draft, nodeId).skills).not.toBe(source.role.skills);
    expect(roleOf(draft, nodeId).harness).not.toBe(source.role.harness);
    const again = addAtEnd(draft, source);
    expect(again.nodeId).not.toBe(nodeId);
    expect(roleOf(again.draft, again.nodeId).id).not.toBe(roleOf(draft, nodeId).id);
    expect(again.draft.definition.roles).toHaveLength(3);
  });

  it('copies a saved agent’s description, kept over JSON export and import; a built-in copy has none', () => {
    const source = writer();
    const description = 'Writes announcements. Use it for public notes.';
    const added = addAtEnd(flow(), { ...source, role: { ...source.role, description } });
    expect(roleOf(added.draft, added.nodeId).description).toBe(description);
    const reopened = importDefinition(exportDefinition(added.draft));
    if (!reopened.ok) throw new Error(reopened.errors.join(', '));
    expect(reopened.draft.definition).toEqual(added.draft.definition);
    const { id: _id, ...preset } = roleFromPreset('writer', 'writer', 'Writing');
    const builtin = addAtEnd(flow(), {
      role: preset,
      origin: { kind: 'preset', presetId: 'writer' },
      stepInstruction: 'Write the notice.',
    });
    expect(roleOf(builtin.draft, builtin.nodeId)).not.toHaveProperty('description');
  });

  it('never collides with an existing imported role id derived from the new node id', () => {
    const before = flow();
    const existing = { ...roleOf(before, 'agent_1'), id: 'agent_2_role' };
    const draft = {
      ...before,
      definition: { ...before.definition, roles: [...before.definition.roles, existing] },
    };
    const added = addAtEnd(draft, writer());
    expect(roleOf(added.draft, added.nodeId).id).not.toBe(existing.id);
    expect(added.draft.definition.roles).toContain(existing);
  });

  it('adds the first producer and bound result together, including a reviewer after an observer', () => {
    const before = ok(placeStep(emptyDraft(), 'observer', standalone)).draft;
    const source = writer();
    source.role.outputContract = 'review';
    const { draft, nodeId } = addAtEnd(before, source);
    expect(draft.definition.nodes).toHaveLength(3);
    expect(draft.definition.nodes.find((n) => n.type === 'output')).toMatchObject({
      inputBindings: [{ kind: 'task_output', name: 'text', sourceNodeId: nodeId }],
    });
    expect(draft.definition.controlEdges).toMatchObject([{ source: nodeId, target: 'output_1' }]);
  });

  it.each([
    ['implement-review', 'implement'],
    ['feature', 'implement'],
    ['bug-fix', 'fix'],
    ['refactor', 'reshape'],
    ['performance', 'improve'],
  ] as const)(
    'inserts one seat on both final Loop routes in %s, without changing its submission',
    (id, worker) => {
      const definition = teamTemplate(id, 'example', {
        name: id,
        brief: 'Prepare a result.',
        criteria: ['Reviewed'],
        labels: {
          loop: 'Review loop',
          decision: 'Decision',
          verifyLoop: 'Verification loop',
          verifyDecision: 'Verification decision',
          join: 'Gather',
          output: 'Output',
        },
        roles: Object.fromEntries(
          Object.keys(TEAM_TEMPLATE_ROLES[id]).map((key) => [key, { name: key, duty: key }]),
        ) as never,
      });
      const store = createEditorStore(draftFromDefinition(definition));
      const original = store.getState().draft;
      const output = original.definition.nodes.find((n) => n.type === 'output');
      if (!output) throw new Error('Missing final result');
      const { draft, nodeId } = addAtEnd(original, writer());
      expect(draft.definition.controlEdges.filter((e) => e.target === nodeId)).toMatchObject([
        { source: 'review_loop', sourcePort: 'next', targetPort: 'in' },
        { source: 'review_loop', sourcePort: 'exhausted', targetPort: 'in' },
      ]);
      expect(draft.definition.controlEdges.filter((e) => e.target === output.id)).toMatchObject([
        { source: nodeId, sourcePort: 'out', targetPort: 'in' },
      ]);
      expect(draft.definition.nodes.find((n) => n.id === output.id)).toBe(output);
      expect(agent(draft, nodeId).inputBindings).toEqual([
        { kind: 'run_input', name: 'brief' },
        {
          kind: 'task_output',
          name: 'draft',
          sourceNodeId: worker,
        },
      ]);
      expect(compileDefinition(draft.definition).diagnostics).toEqual([]);
      store.getState().applyDraft(draft);
      store.getState().undo();
      expect(store.getState().draft.definition).toBe(original.definition);
      expect(store.getState().canUndo).toBe(false);
    },
  );

  it('receives the planner’s output before the single-agent team’s final result', () => {
    const before = patchNode(flow(), 'agent_1', { label: 'Planner', outputName: 'plan' });
    const { draft, nodeId } = addAtEnd(before, writer());
    expect(draft.definition.controlEdges).toMatchObject([
      { source: 'agent_1', target: nodeId },
      { source: nodeId, target: 'output_1' },
    ]);
    expect(agent(draft, nodeId).inputBindings).toEqual([
      { kind: 'run_input', name: 'brief' },
      { kind: 'task_output', name: 'plan', sourceNodeId: 'agent_1' },
    ]);
    expect(draft.definition.nodes.find((n) => n.type === 'output')).toBe(
      before.definition.nodes[1],
    );
  });

  it('takes each final producer once, using distinct output names instead of submission aliases', () => {
    const first = patchNode(flow(), 'agent_1', { outputName: 'brief' });
    const second = ok(placeStep(first, 'agent', { kind: 'after', nodeId: 'agent_1' }));
    const renamed = patchNode(second.draft, second.nodeId, { outputName: 'brief' });
    const before = patchNode(renamed, 'output_1', {
      inputBindings: [
        { kind: 'task_output', sourceNodeId: 'agent_1', name: 'summary', optional: true },
        { kind: 'task_output', sourceNodeId: 'agent_1', name: 'copy' },
        { kind: 'task_output', sourceNodeId: second.nodeId, name: 'appendix', optional: true },
      ],
    });
    const { draft, nodeId } = addAtEnd(before, writer());
    expect(agent(draft, nodeId).inputBindings).toEqual([
      { kind: 'run_input', name: 'brief' },
      { kind: 'task_output', name: 'brief_2', sourceNodeId: 'agent_1' },
      { kind: 'task_output', name: 'brief_3', sourceNodeId: second.nodeId, optional: true },
    ]);
    expect(compileDefinition(draft.definition).diagnostics).toEqual([]);

    const finalEdge = before.definition.controlEdges.find((e) => e.target === 'output_1');
    if (!finalEdge) throw new Error('Missing final edge');
    const onEdge = ok(addAgent(before, writer(), { kind: 'edge', edgeId: finalEdge.id }));
    expect(agent(onEdge.draft, onEdge.nodeId).inputBindings).toEqual([
      { kind: 'run_input', name: 'brief' },
      { kind: 'task_output', name: 'brief_2', sourceNodeId: second.nodeId },
    ]);
  });

  it('suggests the nearest upstream producer when the Output has no result binding', () => {
    const before = patchNode(flow(), 'output_1', { inputBindings: [] });
    const { draft, nodeId } = addAtEnd(before, writer());
    expect(agent(draft, nodeId).inputBindings).toEqual([
      { kind: 'run_input', name: 'brief' },
      { kind: 'task_output', name: 'text', sourceNodeId: 'agent_1' },
    ]);
    expect(draft.definition.nodes.find((n) => n.type === 'output')).toBe(
      before.definition.nodes[1],
    );
  });

  it.each(['twoOutputs', 'differentSources', 'disconnectedOutput', 'noOutput'])(
    'adds an unconnected agent without changing existing inputs or edges: %s',
    (shape) => {
      let before = flow();
      if (shape === 'twoOutputs') before = ok(placeStep(before, 'output', standalone)).draft;
      if (shape === 'differentSources') {
        const sibling = ok(placeStep(before, 'agent', standalone));
        const [incoming] = before.definition.controlEdges;
        if (!incoming) throw new Error('Missing final connection');
        before = {
          ...sibling.draft,
          definition: {
            ...sibling.draft.definition,
            controlEdges: [incoming, { ...incoming, id: 'another', source: sibling.nodeId }],
          },
        };
      }
      if (shape === 'disconnectedOutput')
        before = ok(placeStep(emptyDraft(), 'output', standalone)).draft;
      if (shape === 'noOutput') before = ok(placeStep(emptyDraft(), 'agent', standalone)).draft;
      expect(compositionPlacement(before.definition)).toEqual(standalone);
      const { draft, nodeId } = addAtEnd(before, writer());
      expect(draft.definition.controlEdges).toBe(before.definition.controlEdges);
      expect(draft.definition.nodes.filter((n) => n.id !== nodeId)).toEqual(
        before.definition.nodes,
      );
      expect(agent(draft, nodeId).inputBindings).toEqual([{ kind: 'run_input', name: 'brief' }]);
    },
  );

  it('starts an empty composition with one agent, Output, connection and bound result', () => {
    const { draft, nodeId } = addAtEnd(emptyDraft(), writer());
    expect(draft.definition.nodes).toMatchObject([
      { id: nodeId, type: 'agent' },
      { type: 'output', inputBindings: [{ kind: 'task_output', sourceNodeId: nodeId }] },
    ]);
    expect(draft.definition.controlEdges).toMatchObject([{ source: nodeId, target: 'output_1' }]);
  });

  it('keeps an unavailable model profile for the host diagnostic', () => {
    const source = writer();
    const { draft, nodeId } = addAtEnd(emptyDraft(), source);
    expect(
      compileDefinition(draft.definition, { knownModelProfiles: ['other'] }).diagnostics,
    ).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_MODEL_PROFILE', nodeId }));
  });
});

describe('replacing the role, not the seat', () => {
  function owned() {
    let draft = patchNode(flow(), 'agent_1', {
      stepInstruction: 'The seat task.',
      label: 'My seat',
    });
    draft = updateNode(draft, 'agent_1', { teamPlanOwner: true });
    const observer = ok(placeStep(draft, 'observer', { kind: 'after', nodeId: 'agent_1' }));
    return {
      ...observer.draft,
      definition: {
        ...observer.draft.definition,
        sharedOutrider: {
          modelProfile: 'model-a',
          principles: 'Point out risks.',
          targets: { kind: 'selected' as const, nodeIds: ['agent_1'] },
        },
      },
    };
  }
  it('keeps authored seat fields, relationships and result, and moves the sole owner', () => {
    const before = owned();
    const source = writer();
    const store = createEditorStore(before);
    const preview = previewReplaceAgent(before, 'agent_1', source);
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.changed).toEqual(['instructions', 'model', 'permissions', 'skills', 'format']);
    expect(preview.kept).toEqual(
      expect.arrayContaining([
        'id',
        'label',
        'task',
        'inputBindings',
        'controlEdges',
        'capabilityLinks',
        'outputBindings',
        'outriderTargets',
      ]),
    );
    // Cancelling the preview never touched the store.
    expect(store.getState().draft).toBe(before);
    expect(store.getState().past).toEqual([]);
    const { draft } = ok(replaceAgent(before, 'agent_1', source));
    const newRole = roleOf(draft, 'agent_1');
    expect(newRole).toMatchObject({ ...source.role, origin: source.origin });
    expect(newRole.harness).not.toBe(source.role.harness);
    expect(newRole.id).not.toBe(before.definition.planOwnerRoleId);
    expect(draft.definition.planOwnerRoleId).toBe(newRole.id);
    expect(draft.definition.roles.map((r) => r.id)).not.toContain(
      before.definition.planOwnerRoleId,
    );
    expect(agent(draft, 'agent_1')).toEqual({ ...agent(before, 'agent_1'), roleId: newRole.id });
    expect(draft.definition.nodes.find((n) => n.type === 'output')).toBe(
      before.definition.nodes[1],
    );
    expect(draft.definition.capabilityLinks).toBe(before.definition.capabilityLinks);
    expect(draft.definition.controlEdges).toBe(before.definition.controlEdges);
    expect(draft.definition.sharedOutrider).toBe(before.definition.sharedOutrider);
    store.getState().applyDraft(draft);
    const same = ok(
      replaceAgent(draft, 'agent_1', { ...structuredClone(source), stepInstruction: 'Ignored' }),
    );
    expect(same.draft).toBe(draft);
    store.getState().applyDraft(same.draft);
    expect(store.getState().past).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().draft).toBe(before);
  });

  it.each(['handmade', 'step', 'origin'] as const)(
    'keeps the %s seat’s task through preview, replacement and undo',
    (kind) => {
      const sentence = 'Write a two-sentence invitation.';
      const initial =
        kind === 'origin'
          ? addAtEnd(emptyDraft(), {
              role: writer().role,
              origin: { kind: 'preset', presetId: 'writer' },
            }).draft
          : flow();
      let before = updateNode(initial, 'agent_1', { prompt: sentence });
      if (kind === 'step')
        before = patchNode(before, 'agent_1', { stepInstruction: 'Invite the neighbors.' });
      const { name, duty } = messages.TeamTemplates.presets.architect;
      const preset = roleFromPreset('architect', 'architect', name);
      const source: AgentSource = {
        role: preset,
        origin: { kind: 'preset', presetId: 'architect' },
        stepInstruction: duty,
      };
      const expectedTask =
        kind === 'handmade' ? sentence : kind === 'step' ? 'Invite the neighbors.' : duty;
      const preview = previewReplaceAgent(before, 'agent_1', source);
      if (!preview.ok) throw new Error(preview.reason);
      const { draft } = ok(replaceAgent(before, 'agent_1', source));
      expect(preview.draft.definition).toEqual(draft.definition);
      expect(seatTask(draft.definition, 'agent_1')).toEqual({
        target: 'step',
        text: expectedTask,
        base: preset.prompt,
      });
      expect(preview.kept.includes('task')).toBe(kind !== 'origin');
      expect(preview.changed.includes('task')).toBe(kind === 'origin');
      expect(agent(draft, 'agent_1').stepInstruction).toBe(expectedTask);
      expect(compileDefinition(draft.definition).diagnostics).toEqual([]);
      const store = createEditorStore(before);
      store.getState().applyDraft(draft);
      store.getState().undo();
      expect(store.getState().draft.definition).toBe(before.definition);
      expect(store.getState().canUndo).toBe(false);
    },
  );

  it('fills only the missing task when choosing the same preset, but not a library original', () => {
    const source: AgentSource = {
      role: writer().role,
      origin: { kind: 'preset', presetId: 'writer' },
    };
    const { draft, nodeId } = addAtEnd(emptyDraft(), source);
    const preview = previewReplaceAgent(draft, nodeId, { ...source, stepInstruction: 'Draft it.' });
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.changed).toEqual(['task']);
    expect(preview.kept).not.toContain('task');
    expect(agent(preview.draft, nodeId).stepInstruction).toBe('Draft it.');
    const library = previewReplaceAgent(draft, nodeId, {
      role: source.role,
      origin: { kind: 'library', agentId: 'writer', revision: 4 },
    });
    if (!library.ok) throw new Error(library.reason);
    expect(library.changed).not.toContain('task');
    expect(seatTask(library.draft.definition, nodeId)?.text).toBe('');
  });

  it('fills an empty seat from another team’s handmade role without duplicating its one prompt', () => {
    const { draft, nodeId } = addAtEnd(emptyDraft(), {
      role: writer().role,
      origin: { kind: 'preset', presetId: 'writer' },
    });
    const preview = previewReplaceAgent(draft, nodeId, { role: writer().role });
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.changed).toEqual(['task']);
    expect(preview.kept).not.toContain('task');
    expect(seatTask(preview.draft.definition, nodeId)).toMatchObject({
      target: 'role',
      text: writer().role.prompt,
    });
    expect(agent(preview.draft, nodeId)).not.toHaveProperty('stepInstruction');
  });

  it('previews an MCP-only change as permissions and keeps each copy independent of its original', () => {
    const source = writer();
    const tool = { serverId: 'issues', name: 'mcp__issues__search' };
    source.role.mcpTools = [tool];
    const { draft, nodeId } = addAtEnd(emptyDraft(), source);
    const first = roleOf(draft, nodeId);
    expect(first.mcpTools).toEqual([{ ...tool }]);
    expect(first.mcpTools).not.toBe(source.role.mcpTools);
    expect(first.mcpTools?.[0]).not.toBe(tool);

    tool.name = 'mcp__issues__update';
    expect(first.mcpTools?.[0]?.name).toBe('mcp__issues__search');
    const preview = previewReplaceAgent(draft, nodeId, source);
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.changed).toEqual(['permissions']);
    const replacement = roleOf(preview.draft, nodeId);
    expect(replacement.mcpTools).toEqual([tool]);
    expect(replacement.mcpTools?.[0]).not.toBe(tool);
    const same = previewReplaceAgent(preview.draft, nodeId, structuredClone(source));
    if (!same.ok) throw new Error(same.reason);
    expect(same.changed).toEqual([]);
    expect(same.draft).toBe(preview.draft);
  });

  it('does not describe name or provenance as a capability change', () => {
    const initial = writer();
    const { draft, nodeId } = addAtEnd(emptyDraft(), initial);
    const other: AgentSource = {
      role: { ...initial.role, name: 'A second writer' },
      origin: { kind: 'library', agentId: 'other_writer', revision: 1 },
    };
    const preview = previewReplaceAgent(draft, nodeId, other);
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.changed).toEqual([]);
    expect(roleOf(preview.draft, nodeId)).toMatchObject({
      name: other.role.name,
      origin: other.origin,
    });
    expect(agent(preview.draft, nodeId).label).toBe(initial.role.name);
  });

  it('refuses to orphan an owner but leaves a shared owner with the remaining seat', () => {
    const source = writer();
    source.role.allowedCollaborationTools = ['submit_result'];
    const before = owned();
    const store = createEditorStore(before);
    for (const command of [previewReplaceAgent, replaceAgent]) {
      expect(command(store.getState().draft, 'agent_1', source)).toMatchObject({
        ok: false,
        reason: 'movePlanOwner',
      });
    }
    expect(store.getState().draft).toBe(before);
    expect(store.getState().past).toEqual([]);
    const other = ok(placeStep(before, 'agent', { kind: 'after', nodeId: 'agent_1' }));
    const shared = patchNode(other.draft, other.nodeId, {
      roleId: agent(before, 'agent_1').roleId,
    });
    const { draft } = ok(replaceAgent(shared, 'agent_1', source));
    expect(draft.definition.planOwnerRoleId).toBe(before.definition.planOwnerRoleId);
    expect(roleOf(draft, other.nodeId)).toBe(roleOf(before, 'agent_1'));
  });

  it('rejects the first new error even if its code already existed on another link', () => {
    const before = flow();
    const second = ok(placeStep(before, 'agent', { kind: 'after', nodeId: 'agent_1' }));
    const helper = ok(placeStep(second.draft, 'agent', standalone));
    const callable = updateNode(helper.draft, helper.nodeId, { invocation: 'callable' });
    const firstLink = connectCapability(callable, 'agent_1', helper.nodeId, 'delegate');
    if (!firstLink.ok) throw new Error(firstLink.reason);
    const secondLink = connectCapability(firstLink.draft, second.nodeId, helper.nodeId, 'delegate');
    if (!secondLink.ok) throw new Error(secondLink.reason);
    const draft = {
      ...secondLink.draft,
      definition: {
        ...secondLink.draft.definition,
        roles: secondLink.draft.definition.roles.map((r) =>
          r.id === roleOf(before, 'agent_1').id ? roleOf(before, 'agent_1') : r,
        ),
      },
    };
    expect(compileDefinition(draft.definition).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CAPABILITY_NOT_ALLOWED', linkId: firstLink.linkId }),
    );
    const store = createEditorStore(draft);
    const source = writer();
    expect(replaceAgent(draft, second.nodeId, source)).toMatchObject({
      ok: false,
      reason: 'replacementCompileError',
      diagnostic: { code: 'CAPABILITY_NOT_ALLOWED', linkId: secondLink.linkId },
    });
    expect(store.getState().draft).toBe(draft);
    expect(store.getState().past).toEqual([]);
    // An unrelated existing error must not prevent replacing the callable.
    expect(replaceAgent(draft, helper.nodeId, source).ok).toBe(true);
  });

  it('names the downstream review decision whose required output contract is lost', () => {
    const { draft } = ok(applyPattern(flow(), 'reviewLoop', ['agent_1']));
    const reviewer = draft.definition.nodes.find(
      (n) => isWorkAgent(n) && roleOf(draft, n.id).outputContract === 'review',
    );
    const decision = draft.definition.nodes.find((n) => n.type === 'decision');
    if (!reviewer || !decision) throw new Error('Missing review gate');
    expect(replaceAgent(draft, reviewer.id, writer())).toMatchObject({
      ok: false,
      reason: 'replacementCompileError',
      diagnostic: { code: 'REVIEW_CONTRACT', nodeId: decision.id },
    });
  });

  it.each(ROLE_PRESET_IDS)(
    'copies the %s preset without changing the source or explicit inputs',
    (id) => {
      const source = roleFromPreset(id, id, messages.TeamTemplates.presets[id].name);
      const before = flow();
      const { draft } = ok(
        replaceAgent(before, 'agent_1', { role: source, origin: { kind: 'preset', presetId: id } }),
      );
      expect(compileDefinition(draft.definition).ok).toBe(true);
      expect(agent(draft, 'agent_1').inputBindings).toBe(agent(before, 'agent_1').inputBindings);
      expect(roleOf(draft, 'agent_1').id).not.toBe(source.id);
      expect(roleOf(draft, 'agent_1').allowedWorkTools).not.toBe(source.allowedWorkTools);
    },
  );
});

describe('the task field', () => {
  it.each([false, true])(
    'uses the existing step instruction with or without origin: %s',
    (origin) => {
      const source = writer();
      if (!origin) delete source.origin;
      const { draft, nodeId } = addAtEnd(emptyDraft(), source);
      expect(seatTask(draft.definition, nodeId)).toEqual({
        target: 'step',
        text: source.stepInstruction,
        base: source.role.prompt,
      });
      const edited = ok(setSeatTask(draft, nodeId, '  New task\n')).draft;
      expect(agent(edited, nodeId).stepInstruction).toBe('  New task\n');
      expect(ok(setStepInstruction(edited, nodeId, '  New task\n')).draft).toBe(edited);
      const cleared = ok(setStepInstruction(edited, nodeId, ' \n')).draft;
      expect(agent(cleared, nodeId)).not.toHaveProperty('stepInstruction');
      expect(ok(setStepInstruction(cleared, nodeId, '')).draft).toBe(cleared);
      expect(seatTask(cleared.definition, nodeId)).toEqual(
        origin
          ? { target: 'step', text: '', base: source.role.prompt }
          : { target: 'role', text: source.role.prompt, base: null },
      );
    },
  );
  it('edits only the selected legacy seat and does not fork its role for the same task', () => {
    const first = flow();
    const second = ok(placeStep(first, 'agent', { kind: 'after', nodeId: 'agent_1' }));
    const shared = patchNode(second.draft, second.nodeId, {
      roleId: agent(first, 'agent_1').roleId,
    });
    const role = roleOf(first, 'agent_1');
    expect(ok(setSeatTask(shared, 'agent_1', role.prompt)).draft).toBe(shared);
    const changed = ok(setSeatTask(shared, 'agent_1', 'Write an invitation.')).draft;
    expect(roleOf(changed, 'agent_1').prompt).toBe('Write an invitation.');
    expect(agent(changed, 'agent_1')).not.toHaveProperty('stepInstruction');
    expect(roleOf(changed, second.nodeId)).toBe(role);
  });
});
