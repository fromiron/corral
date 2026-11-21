import { type InputBinding, isWorkAgent } from '@corral/contracts';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { emptyDraft } from '../src/editor/model.ts';
import { createEditorStore } from '../src/editor/store.ts';
import messages from '../src/messages/en.json' with { type: 'json' };
import korean from '../src/messages/ko.json' with { type: 'json' };
import { type EditResult, patchNode, placeStep } from '../src/team-editor/commands.ts';
import { InspectorSheet, type InspectorSheetProps } from '../src/team-editor/InspectorSheet.tsx';
import { RoleForm } from '../src/team-editor/NodeSettings.tsx';

function ok(result: EditResult) {
  if (!result.ok || !result.nodeId) throw new Error('Placement failed');
  return { draft: result.draft, nodeId: result.nodeId };
}

function team() {
  const author = ok(placeStep(emptyDraft(), 'agent', { kind: 'empty' }));
  const source = ok(
    placeStep(
      author.draft,
      'team',
      { kind: 'after', nodeId: author.nodeId },
      {
        reference: { corralId: 'research', name: 'Research team', definitionRevision: 3 },
      },
    ),
  );
  const seat = ok(placeStep(source.draft, 'agent', { kind: 'after', nodeId: source.nodeId }));
  const later = ok(placeStep(seat.draft, 'agent', { kind: 'after', nodeId: seat.nodeId }));
  return patchNode(later.draft, 'agent_1', { outputName: 'Outline' });
}

function open(draft = team(), props: Partial<InspectorSheetProps> = {}) {
  const editor = createEditorStore(draft);
  render(
    <IntlProvider locale="en" messages={messages}>
      <InspectorSheet
        editor={editor}
        profiles={null}
        imageProfiles={null}
        diagnostics={[]}
        teams={[]}
        outriderTargets={[]}
        selection={{ nodes: ['agent_2'], edge: null }}
        view="selection"
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onTeamSettings={vi.fn()}
        {...props}
      />
    </IntlProvider>,
  );
  const seat = () => {
    const node = editor.getState().draft.definition.nodes.find((n) => n.id === 'agent_2');
    if (!isWorkAgent(node)) throw new Error('Expected a work seat');
    return node;
  };
  const role = () => {
    const result = editor.getState().draft.definition.roles.find((r) => r.id === seat().roleId);
    if (!result) throw new Error('Expected a role for the seat');
    return result;
  };
  return { editor, seat, role };
}
const precedes = (a: Element, b: Element) =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const choose = async (name: string, option: string) => {
  await userEvent.click(screen.getByRole('combobox', { name }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
};
const button = (name: string) => screen.getByRole('button', { name });

describe('work seat settings', () => {
  it.each([false, true])(
    'puts problems and work before advanced settings (docked: %s)',
    async (docked) => {
      open(patchNode(team(), 'agent_2', { stepInstruction: 'Review the outline.' }), {
        docked,
        roleSkills: () => <p>Selected skills</p>,
        roleTools: () => <p>Selected tools</p>,
        roleSettings: () => <p>Execution policy</p>,
        diagnostics: [
          { code: 'UNREACHABLE', severity: 'error', nodeId: 'agent_2', message: 'Unreachable' },
        ],
      });
      const issues = screen.getByRole('region', { name: messages.TeamEditor.issues });
      const region = { name: messages.TeamEditor.connections };
      if (docked) expect(screen.queryByRole('region', region)).toBeNull();
      else expect(precedes(screen.getByRole('region', region), issues)).toBe(true);
      const order = [
        issues,
        screen.getByRole('textbox', { name: 'Name' }),
        screen.getByRole('textbox', { name: 'Task' }),
        button('Base instructions'),
        screen.getByRole('group', { name: 'Receives' }),
        screen.getByRole('heading', { name: 'Skills' }),
        screen.getByRole('heading', { name: 'External tools' }),
        button('Advanced'),
      ];
      order.reduce((previous, next) => {
        expect(precedes(previous, next)).toBe(true);
        return next;
      });
      expect(button('Advanced')).toHaveAttribute('aria-expanded', 'false');
      expect(button('Base instructions')).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByText('Selected skills')).toBeVisible();
      expect(Boolean(screen.queryByRole('button', { name: messages.TeamEditor.wrapLoop }))).toBe(
        !docked,
      );
      await userEvent.click(button('Advanced'));
      const advanced = within(screen.getByRole('region', { name: 'Advanced' }));
      await waitFor(() =>
        expect(advanced.getByRole('textbox', { name: 'Model profile' })).toBeVisible(),
      );
      expect(advanced.getByRole('combobox', { name: messages.Reasoning.label })).toBeVisible();
      expect(advanced.getByRole('switch', { name: messages.Inspector.fileTools })).toBeVisible();
      expect(advanced.getByRole('combobox', { name: messages.Inspector.contract })).toBeVisible();
      expect(advanced.getByText('Execution policy')).toBeVisible();
      expect(
        advanced.getByRole('radiogroup', { name: messages.Inspector.invocation }),
      ).toBeVisible();
      expect(advanced.getByRole('group', { name: messages.Inspector.calls })).toBeVisible();
      expect(
        advanced.getByRole('spinbutton', { name: messages.TeamEditor.fields.retry }),
      ).toBeVisible();
      expect(
        advanced.getByRole('textbox', { name: messages.TeamEditor.fields.note }),
      ).toBeVisible();
    },
  );

  it.each(['origin', 'step', 'role'] as const)(
    'edits the %s task in one focus session, not on selection',
    async (kind) => {
      const draft =
        kind === 'step' ? patchNode(team(), 'agent_2', { stepInstruction: 'Rework.' }) : team();
      if (kind === 'origin') {
        const agent = draft.definition.roles[1];
        if (!agent) throw new Error('Expected a role for the second seat');
        agent.origin = { kind: 'preset', presetId: 'writing' };
      }
      const { editor, seat, role } = open(draft);
      const task = screen.getByRole('textbox', { name: 'Task' });
      const prompt = role().prompt;
      expect(task).toHaveValue(kind === 'step' ? 'Rework.' : kind === 'role' ? prompt : '');
      expect(screen.queryByRole('heading', { name: 'Skills' })).toBeNull();
      const base = screen.queryByRole('button', { name: 'Base instructions' });
      if (kind === 'role') expect(base).toBeNull();
      else expect(base).toHaveAttribute('aria-expanded', String(kind === 'origin'));
      if (kind === 'origin')
        expect(task).toHaveAttribute('placeholder', expect.stringMatching(/team/));
      fireEvent.focus(task);
      fireEvent.blur(task);
      expect(editor.getState().past).toEqual([]);
      fireEvent.focus(task);
      fireEvent.change(task, { target: { value: 'One' } });
      fireEvent.change(task, { target: { value: 'One revised task' } });
      fireEvent.blur(task);
      expect(editor.getState().past).toEqual([draft]);
      expect(seat().stepInstruction).toBe(kind === 'role' ? undefined : 'One revised task');
      expect(role()?.prompt).toBe(kind === 'role' ? 'One revised task' : prompt);
      if (kind !== 'role') {
        expect(button('Base instructions')).toHaveAttribute('aria-expanded', 'false');
        await userEvent.click(button('Base instructions'));
        const field = screen.getByRole('textbox', { name: 'Base instructions' });
        fireEvent.change(field, { target: { value: 'General duty' } });
        expect(role()?.prompt).toBe('General duty');
        expect(seat().stepInstruction).toBe('One revised task');
      }
    },
  );

  it('retains the step target through select-all and clearing, and restores the draft when typing ends unchanged', () => {
    const draft = patchNode(team(), 'agent_2', { stepInstruction: 'Start here' });
    const { editor, role, seat } = open(draft);
    const prompt = role()?.prompt;
    const task = screen.getByRole('textbox', { name: 'Task' });
    fireEvent.focus(task);
    fireEvent.change(task, { target: { value: '' } });
    expect(task).toHaveValue('');
    fireEvent.change(task, { target: { value: 'Start anew' } });
    expect(seat().stepInstruction).toBe('Start anew');
    expect(role()?.prompt).toBe(prompt);
    fireEvent.change(task, { target: { value: 'Start here' } });
    fireEvent.blur(task);
    expect(editor.getState().draft).toBe(draft);
    expect(editor.getState().past).toEqual([]);
  });

  it('opens the connection named by a problem even when it also names the destination node', async () => {
    const draft = team();
    const edge = draft.definition.controlEdges[0];
    if (!edge) throw new Error('Expected a connected team');
    const onSelect = vi.fn();
    open(draft, {
      view: 'problems',
      onSelect,
      diagnostics: [
        {
          code: 'PARALLEL_MERGE_NEEDS_JOIN',
          severity: 'error',
          nodeId: edge.target,
          edgeId: edge.id,
          message: 'Needs a join',
        },
      ],
    });
    await userEvent.click(screen.getByRole('button', { name: /Join/i }));
    expect(onSelect).toHaveBeenCalledWith({ nodes: [], edge: edge.id });
  });

  it.each(['JOIN_SPLIT', 'PARALLEL_MIXED_ENTRY'] as const)(
    'lists %s among the Join problems of a connection, worded in both languages',
    async (code) => {
      const draft = team();
      const edge = draft.definition.controlEdges[0];
      if (!edge) throw new Error('Expected a connected team');
      const onSelect = vi.fn();
      open(draft, {
        selection: { nodes: [], edge: edge.id },
        onSelect,
        diagnostics: [{ code, severity: 'error', nodeId: edge.target, message: 'compiler text' }],
      });
      expect(korean.Validation.codes[code]).toMatch(/합류|분기/);
      await userEvent.click(
        screen.getByRole('button', { name: new RegExp(messages.Validation.codes[code]) }),
      );
      expect(onSelect).toHaveBeenCalledWith({ nodes: [edge.target], edge: null });
      expect(screen.queryByText(/compiler text/)).toBeNull();
    },
  );

  it('names every material by its source and changes only the chosen binding', async () => {
    const bindings: InputBinding[] = [
      { kind: 'task_output', name: 'internal1', sourceNodeId: 'agent_1', optional: true },
      {
        kind: 'previous_iteration_output',
        name: 'internal2',
        sourceNodeId: 'agent_1',
        optional: true,
      },
      { kind: 'explicit_version', name: 'internal3', artifactVersionId: 'v_17' },
      { kind: 'question_answer', name: 'internal4' },
      { kind: 'run_input', name: 'brief' },
    ];
    const draft = patchNode(team(), 'agent_2', { inputBindings: bindings });
    const { editor, seat } = open(draft);
    for (const text of [
      'Agent 1 · Outline',
      'Previous round · Agent 1',
      'Pinned version · v_17',
      'Question answer',
      'Team request',
    ]) {
      expect(screen.getByRole('button', { name: `Remove ${text}` })).toBeVisible();
    }
    await choose('Change Agent 1 · Outline', 'Agent 1 · Outline');
    expect(editor.getState().past).toEqual([]);
    await choose('Change Agent 1 · Outline', 'Research team · Team result');
    expect(seat().inputBindings).toEqual([
      { ...bindings[0], sourceNodeId: 'team_1' },
      ...bindings.slice(1),
    ]);
    expect(editor.getState().draft.definition.controlEdges).toBe(draft.definition.controlEdges);
    await userEvent.click(button('Remove Pinned version · v_17'));
    expect(seat().inputBindings).not.toContain(bindings[2]);
  });

  it('offers the team request and only earlier step results with unambiguous binding names', async () => {
    const { seat } = open(
      patchNode(team(), 'agent_2', {
        inputBindings: [{ kind: 'question_answer', name: 'Outline' }],
      }),
    );
    await userEvent.click(screen.getByRole('combobox', { name: 'Add material' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual([
      'Team request',
      'Agent 1 · Outline',
      'Research team · Team result',
    ]);
    await userEvent.click(screen.getByRole('option', { name: 'Agent 1 · Outline' }));
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(seat().inputBindings.at(-1)).toEqual({
      kind: 'task_output',
      sourceNodeId: 'agent_1',
      name: 'Outline_2',
    });
    await choose('Add material', 'Research team · Team result');
    expect(seat().inputBindings.at(-1)).toEqual({
      kind: 'task_output',
      sourceNodeId: 'team_1',
      name: 'result',
    });
    await choose('Add material', 'Team request');
    expect(seat().inputBindings.at(-1)).toEqual({ kind: 'run_input', name: 'brief' });
    await userEvent.click(screen.getByRole('combobox', { name: 'Add material' }));
    expect(screen.queryByRole('option', { name: 'Team request' })).toBeNull();
  });

  it('hides Add material when the first seat already receives the request', async () => {
    open(patchNode(team(), 'agent_1', { inputBindings: [{ kind: 'run_input', name: 'brief' }] }), {
      selection: { nodes: ['agent_1'], edge: null },
    });
    expect(screen.queryByRole('combobox', { name: 'Add material' })).toBeNull();
    expect(button('Other kinds of material')).toBeVisible();
    await userEvent.click(button('Remove Team request'));
    expect(screen.getByRole('combobox', { name: 'Add material' })).toBeVisible();
  });

  it('names the criteria input apart from the team request, as the team names its criteria', () => {
    open(
      patchNode(team(), 'agent_1', {
        inputBindings: [
          { kind: 'run_input', name: 'brief' },
          { kind: 'run_input', name: 'criteria' },
        ],
      }),
      { selection: { nodes: ['agent_1'], edge: null } },
    );
    expect(button('Remove Team request')).toBeVisible();
    expect(button(`Remove ${messages.Inspector.teamCriteria}`)).toBeVisible();
    expect(messages.Inspector.teamCriteria).not.toBe(messages.Inspector.teamRequest);
  });

  it('offers a named choice for required material with a missing source', async () => {
    const { seat } = open(
      patchNode(team(), 'agent_2', {
        inputBindings: [
          { kind: 'task_output', name: 'missing' },
          { kind: 'task_output', name: 'optional', optional: true },
        ],
      }),
    );
    await choose('Choose material to receive', 'Team request');
    expect(seat().inputBindings).toEqual([
      { kind: 'run_input', name: 'brief' },
      { kind: 'task_output', name: 'optional', optional: true },
    ]);
  });

  it.each([
    'run_input',
    'task_output',
    'previous_iteration_output',
    'explicit_version',
    'question_answer',
  ] as const)('still authors %s with a custom name', async (kind) => {
    const { seat } = open();
    await userEvent.click(button('Other kinds of material'));
    await choose('Kind', messages.Inspector.inputKinds[kind]);
    if (kind === 'task_output' || kind === 'previous_iteration_output')
      await choose('From', 'Agent 1');
    if (kind === 'explicit_version')
      fireEvent.change(screen.getByRole('textbox', { name: 'Result version' }), {
        target: { value: 'v_17' },
      });
    const inputs = within(screen.getByRole('group', { name: 'Inputs' }));
    fireEvent.change(inputs.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'chosen_name' },
    });
    await userEvent.click(inputs.getByRole('button', { name: 'Add' }));
    expect(seat().inputBindings.at(-1)).toEqual({
      kind,
      name: 'chosen_name',
      ...(['task_output', 'previous_iteration_output'].includes(kind)
        ? { sourceNodeId: 'agent_1' }
        : {}),
      ...(kind === 'previous_iteration_output' ? { optional: true } : {}),
      ...(kind === 'explicit_version' ? { artifactVersionId: 'v_17' } : {}),
    });
  });

  it('offers replacement, graph navigation and deletion from the seat menu', async () => {
    const onReplaceAgent = vi.fn(),
      onShowInGraph = vi.fn(),
      onSelect = vi.fn();
    const { editor } = open(team(), { docked: true, onReplaceAgent, onShowInGraph, onSelect });
    for (const [label, callback] of [
      ['Replace with another agent', onReplaceAgent],
      ['Show in flow graph', onShowInGraph],
    ] as const) {
      await userEvent.click(button(messages.Inspector.seatActions));
      await userEvent.click(await screen.findByRole('menuitem', { name: label }));
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
      if (callback === onReplaceAgent)
        expect(callback).toHaveBeenCalledWith('agent_2', button(messages.Inspector.seatActions));
      else expect(callback).toHaveBeenCalledWith('agent_2');
    }
    expect(editor.getState().past).toEqual([]);
    await userEvent.click(button(messages.Inspector.seatActions));
    await userEvent.click(
      await screen.findByRole('menuitem', { name: messages.TeamEditor.delete }),
    );
    expect(editor.getState().draft.definition.nodes.some((n) => n.id === 'agent_2')).toBe(false);
    expect(onSelect).toHaveBeenCalledWith({ nodes: [], edge: null });
    act(() => editor.getState().undo());
    expect(editor.getState().draft.definition.nodes.some((n) => n.id === 'agent_2')).toBe(true);
  });

  it('has no close control at rest beside the list', () => {
    open(team(), { view: 'team', selection: { nodes: [], edge: null }, docked: true });
    expect(screen.getByRole('heading', { name: messages.TeamEditor.teamSettings })).toBeVisible();
    expect(screen.queryByRole('button', { name: messages.TeamEditor.close })).toBeNull();
  });
});

it('edits the reusable original without the seat or team settings', async () => {
  const editor = createEditorStore(team());
  render(
    <IntlProvider locale="en" messages={messages}>
      <RoleForm
        editor={editor}
        nodeId="agent_2"
        variant="original"
        profiles={null}
        imageProfiles={null}
        roleSkills={() => <p>My skills</p>}
        roleSettings={() => <p>Policy</p>}
      />
    </IntlProvider>,
  );
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Agent 2');
  const prompt = screen.getByRole('textbox', { name: 'Base instructions' });
  fireEvent.change(prompt, { target: { value: 'Original duty' } });
  expect(editor.getState().draft.definition.roles[1]?.prompt).toBe('Original duty');
  expect(screen.getByText('My skills')).toBeVisible();
  await userEvent.click(button('Advanced'));
  for (const absent of [
    'Task',
    'Receives',
    messages.Inspector.invocation,
    messages.Inspector.calls,
    messages.TeamEditor.fields.note,
    messages.TeamEditor.fields.retry,
    messages.Inspector.teamPlanOwner,
  ])
    expect(screen.queryByText(absent)).toBeNull();
  await waitFor(() => expect(screen.getByText('Policy')).toBeVisible());
  expect(screen.getByRole('textbox', { name: 'Model profile' })).toBeVisible();
  expect(screen.getByRole('combobox', { name: messages.Inspector.contract })).toBeVisible();
});

it('reveals and focuses the policy selector on the docked seat without editing the draft', async () => {
  const { editor } = open(team(), {
    docked: true,
    roleSkills: (_role, _nodeId, context) => (
      <button type="button" onClick={() => context.revealPolicy()}>
        Choose execution policy
      </button>
    ),
    roleSettings: () => (
      <label data-role-policy-field>
        Execution policy
        <select>
          <option>Basic</option>
        </select>
      </label>
    ),
  });
  expect(button('Advanced')).toHaveAttribute('aria-expanded', 'false');
  await userEvent.click(button('Choose execution policy'));
  expect(button('Advanced')).toHaveAttribute('aria-expanded', 'true');
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: 'Execution policy' })).toHaveFocus(),
  );
  expect(editor.getState().past).toEqual([]);
});
