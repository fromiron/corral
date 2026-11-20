import {
  type AgentRole,
  isWorkAgent,
  type LibraryAgent,
  LibraryAgentRole,
} from '@corral/contracts';
import { roleFromPreset } from '@corral/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import { StudioStoresProvider } from '../src/context.tsx';
import { emptyDraft, newWorkAgent } from '../src/editor/model.ts';
import { createEditorStore } from '../src/editor/store.ts';
import messages from '../src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../src/stories/fixtures.tsx';
import { addAgent, importableAgents } from '../src/team-editor/commands.ts';
import { TeamEditor, type TeamEditorProps } from '../src/team-editor/TeamEditor.tsx';

const original: LibraryAgent = {
  agentId: 'author',
  projectId: 'work',
  revision: 5,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  archivedAt: null,
  role: {
    name: 'Writer',
    prompt: 'Polish the manuscript.',
    allowedWorkTools: ['write_artifact'],
    allowedCollaborationTools: ['submit_result'],
    outputContract: 'text',
    modelProfile: 'model-a',
  },
};
const library = {
  status: 'ready' as const,
  agents: [original],
  projectName: 'Harbor',
  retry: vi.fn(),
};
const origin = { kind: 'library' as const, agentId: 'author', revision: 2 };
const writingBase = roleFromPreset(
  'writer',
  'writer',
  messages.TeamTemplates.presets.writer.name,
).prompt;
function mount(
  props: Partial<TeamEditorProps> = {},
  from: AgentRole['origin'] | null = origin,
  stepInstruction = 'Team-only sentence',
  changes: Partial<AgentRole> = {},
) {
  const seat = addAgent(
    emptyDraft(),
    {
      role: { ...original.role, name: 'Planner', ...changes },
      ...(from && { origin: from }),
      stepInstruction,
    },
    { kind: 'empty' },
  );
  if (!seat.ok || !seat.nodeId) throw Error('missing seat');
  const editor = createEditorStore(seat.draft);
  render(
    <IntlProvider locale="en" messages={messages}>
      <StudioStoresProvider editor={editor} session={sessionStore()}>
        <TeamEditor view="composition" editor={editor} agentLibrary={library} {...props} />
      </StudioStoresProvider>
    </IntlProvider>,
  );
  const nodeId = seat.nodeId;
  act(() => editor.getState().select(nodeId));
  return { editor, before: seat.draft, user: userEvent.setup() };
}
const add = () => screen.getByRole('button', { name: /^add agent$/i });
const button = (name: string | RegExp) =>
  within(screen.getByRole('dialog')).getByRole('button', { name });
const search = () => screen.getByRole('textbox', { name: 'Find an agent' });
const tab = (name: RegExp) => screen.getByRole('tab', { name });

it('adds the same original twice without replacing the selected seat; a copied revision and undo per add', async () => {
  const { editor, user, before } = mount({
    agentLibrary: {
      ...library,
      agents: [
        original,
        {
          ...original,
          agentId: 'old',
          archivedAt: original.updatedAt,
          role: { ...original.role, name: 'Archived' },
        },
      ],
    },
  });
  for (const count of [1, 2]) {
    await user.click(add());
    await waitFor(() => expect(search()).toHaveFocus());
    expect(tab(/My agents/)).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('dialog')).toHaveTextContent('Harbor');
    expect(screen.queryByText('Archived')).toBeNull();
    await user.type(search(), 'manuscript');
    await user.click(button(/^Writer/));
    const state = editor.getState();
    expect(state.draft.definition.nodes.find(isWorkAgent)).toEqual(
      before.definition.nodes.find(isWorkAgent),
    );
    const copies = state.draft.definition.nodes
      .filter(isWorkAgent)
      .filter((n) => n.label === 'Writer');
    expect(new Set(copies.map((n) => n.roleId)).size).toBe(count);
    expect(state.draft.definition.roles.at(-1)?.origin).toEqual({ ...origin, revision: 5 });
    expect(state.past).toHaveLength(count);
  }
  act(() => {
    editor.getState().undo();
    editor.getState().undo();
  });
  expect(editor.getState().draft).toBe(before);
});

it('shows a saved agent’s description in its row, finds it by it or its instructions, and copies it', async () => {
  const description = 'Edits long manuscripts. Use it after the first draft.';
  const { editor, user } = mount({
    agentLibrary: {
      ...library,
      agents: [{ ...original, role: { ...original.role, description } }],
    },
  });
  await user.click(add());
  expect(button(/^Writer/)).toHaveAccessibleDescription(description);
  await user.type(search(), 'FIRST DRAFT');
  expect(button(/^Writer/)).toHaveAccessibleDescription(description);
  await user.clear(search());
  await user.type(search(), 'polish the');
  await user.click(button(/^Writer/));
  const copy = editor.getState().draft.definition.roles.at(-1);
  expect(copy).toMatchObject({ description, prompt: original.role.prompt });
});

it('searches only the active group, opens built-in for an empty library, and restores focus on cancel', async () => {
  const { editor, user, before } = mount({ agentLibrary: { ...library, agents: [] } });
  const opener = add();
  await user.click(opener);
  expect(tab(/Built-in/)).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('dialog')).not.toHaveTextContent('Project: Harbor');
  await user.click(tab(/My agents/));
  expect(screen.getByRole('dialog')).toHaveTextContent('Project: Harbor');
  expect(button('Create your own')).toBeVisible();
  await user.click(tab(/Other teams/));
  expect(screen.getByRole('dialog')).not.toHaveTextContent('Project: Harbor');
  await user.click(tab(/Built-in/));
  await user.type(search(), 'each claim');
  expect(button('Writing')).toHaveAccessibleDescription(
    `${messages.TeamTemplates.presets.writer.duty}plain-prose · doc-writing`,
  );
  expect(screen.queryByRole('button', { name: 'Design' })).toBeNull();
  fireEvent.keyDown(search(), { key: 'Escape', isComposing: true });
  expect(search()).toBeVisible();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(opener).toHaveFocus());
  expect(editor.getState().draft).toBe(before);
  expect(editor.getState().past).toEqual([]);
  await user.click(opener);
  await user.click(button(/^Writing/));
  const { roles, nodes } = editor.getState().draft.definition;
  expect(roles.at(-1)).toMatchObject({
    prompt: writingBase,
    origin: { kind: 'preset', presetId: 'writer' },
  });
  expect(nodes.filter(isWorkAgent).at(-1)?.stepInstruction).toBe(
    messages.TeamTemplates.presets.writer.duty,
  );
});

it('keeps built-ins and custom creation usable on a failed library read, with explicit retry', async () => {
  const retry = vi.fn();
  const beginSaveAgent = vi.fn();
  const { editor, user } = mount({
    agentLibrary: { ...library, agents: [], status: 'failed', retry },
    beginSaveAgent,
  });
  await user.click(add());
  await user.click(tab(/My agents/));
  expect(screen.getByRole('alert')).toHaveTextContent(/load/i);
  await user.click(button('Retry'));
  expect(retry).toHaveBeenCalledTimes(1);
  await user.click(tab(/Built-in/));
  expect(button(/^Writing/)).toBeVisible();
  await user.click(button('Create your own'));
  await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Reporter');
  await user.type(screen.getByRole('textbox', { name: 'Task' }), 'Interview the author');
  await user.click(button('Add agent'));
  expect(editor.getState().draft.definition.roles.at(-1)).toMatchObject({
    name: 'Reporter',
    prompt: 'Interview the author',
    modelProfile: 'model-a',
    allowedCollaborationTools: ['submit_result', 'ask_user', 'update_plan'],
  });
  expect(beginSaveAgent).not.toHaveBeenCalled();
});

const teamTask = 'Compare the quotations in the interview.';
const laterTask = 'Index the appendices.';
const handmadeTask = 'Check footnotes.';
function otherTeam() {
  const skills = [{ resourceHash: 'a'.repeat(64), entry: 'writing/SKILL.md' }];
  const shared = { ...original.role, id: 'writer', skills };
  const handmade = { ...original.role, id: 'notes', prompt: handmadeTask };
  const observer: AgentRole = {
    ...original.role,
    id: 'advisor',
    name: 'Observer',
    allowedCollaborationTools: ['advise'],
  };
  return {
    corralId: 'harbor',
    name: 'Harbor',
    definitionRevision: 1,
    agents: importableAgents({
      ...emptyDraft().definition,
      entryNodeId: 'first',
      roles: [shared, handmade, observer],
      // Storage order is deliberately not outline order.
      nodes: [
        { ...newWorkAgent('later', shared), stepInstruction: laterTask },
        { ...newWorkAgent('first', shared), stepInstruction: teamTask },
        newWorkAgent('last', handmade),
      ],
      controlEdges: [
        { id: 'one', source: 'first', sourcePort: 'out', target: 'later', targetPort: 'in' },
        { id: 'two', source: 'later', sourcePort: 'out', target: 'last', targetPort: 'in' },
      ],
    }),
  };
}

it('shows loading, distinct descriptions and resolved skill names rather than an empty group', async () => {
  const { user, editor } = mount({
    agentLibrary: { ...library, status: 'loading' },
    teams: [otherTeam()],
    skillLabel: () => 'House style',
  });
  await user.click(add());
  expect(within(screen.getByRole('dialog')).getByRole('status')).toHaveTextContent(
    'Loading agents…',
  );
  expect(button('Create your own')).toBeVisible();
  await user.click(tab(/Other teams/));
  const rows = within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Writer' });
  expect(rows[0]).toHaveAccessibleDescription(/Harbor.*Compare the quotations.*House style/);
  expect(rows[0]).not.toHaveAccessibleDescription(/manuscript|appendices/);
  expect(rows[1]).toHaveAccessibleDescription(/Check footnotes/);
  expect(screen.queryByRole('button', { name: 'Observer' })).toBeNull();
  await user.type(search(), 'footnotes');
  expect(button('Writer')).toHaveAccessibleDescription(/Check footnotes/);
  await user.click(button('Writer'));
  expect(editor.getState().draft.definition.roles.at(-1)?.prompt).toBe(handmadeTask);
  expect(editor.getState().draft.definition.nodes.filter(isWorkAgent).at(-1)).not.toHaveProperty(
    'stepInstruction',
  );
  await user.click(add());
  await user.click(tab(/Other teams/));
  for (const hidden of ['appendices', 'manuscript']) {
    await user.clear(search());
    await user.type(search(), hidden);
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'Writer' })).toBeNull();
  }
  await user.clear(search());
  await user.type(search(), 'quotations');
  await user.click(button('Writer'));
  expect(editor.getState().draft.definition.roles.at(-1)?.prompt).toBe(original.role.prompt);
  expect(editor.getState().draft.definition.nodes.filter(isWorkAgent).at(-1)?.stepInstruction).toBe(
    teamTask,
  );
});

it.each(['Built-in', 'Other teams'] as const)(
  'previews and fills an empty task on replacement from %s, only on confirmation',
  async (group) => {
    const { user, before, editor } = mount(
      { teams: group === 'Other teams' ? [otherTeam()] : [] },
      origin,
      '',
    );
    await user.click(screen.getByRole('button', { name: messages.Inspector.seatActions }));
    await user.click(
      await screen.findByRole('menuitem', { name: messages.Inspector.replaceAgent }),
    );
    await user.click(tab(new RegExp(group)));
    await user.type(search(), group === 'Built-in' ? 'each claim' : 'quotations');
    await user.click(button(group === 'Built-in' ? 'Writing' : 'Writer'));
    const preview = within(screen.getByRole('dialog'));
    expect(preview.getByRole('list')).toHaveTextContent('Task');
    expect(preview.getByText(/^Seat name,/)).not.toHaveTextContent(/task/i);
    expect(editor.getState().draft).toBe(before);
    await user.click(button('Replace'));
    const { nodes, roles } = editor.getState().draft.definition;
    expect(nodes.find(isWorkAgent)?.stepInstruction).toBe(
      group === 'Built-in' ? messages.TeamTemplates.presets.writer.duty : teamTask,
    );
    expect(roles[0]?.prompt).toBe(group === 'Built-in' ? writingBase : original.role.prompt);
    expect(editor.getState().past).toEqual([before]);
  },
);

it('confirming an identical source leaves the same draft and undo stack', async () => {
  const { user, editor, before } = mount({
    agentLibrary: {
      ...library,
      agents: [
        { ...original, revision: origin.revision, role: { ...original.role, name: 'Planner' } },
      ],
    },
  });
  const opener = screen.getByRole('button', { name: messages.Inspector.seatActions });
  await user.click(opener);
  await user.click(await screen.findByRole('menuitem', { name: messages.Inspector.replaceAgent }));
  await user.click(button('Planner'));
  expect(screen.getByText('These settings stay the same.')).toBeVisible();
  await user.click(button('Replace'));
  await waitFor(() => expect(opener).toHaveFocus());
  expect(editor.getState().draft).toBe(before);
  expect(editor.getState().past).toEqual([]);
});

it('saves only reusable role fields, preserves input on failure and never edits team history', async () => {
  const save = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, message: 'Storage offline' })
    .mockResolvedValue({ ok: true });
  const beginSaveAgent = vi.fn(() => save);
  const { editor, user, before } = mount({ beginSaveAgent });
  await user.click(screen.getByRole('button', { name: messages.Inspector.seatActions }));
  await user.click(await screen.findByRole('menuitem', { name: 'Save to library' }));
  const name = within(screen.getByRole('dialog')).getByRole('textbox', { name: 'Name' });
  expect(name).toHaveValue('Planner');
  await user.clear(name);
  await user.type(name, 'Editorial reviewer');
  const instructions = within(screen.getByRole('dialog')).getByRole('textbox', {
    name: 'Base instructions',
  });
  expect(instructions).toHaveValue(original.role.prompt);
  await user.type(instructions, ' Keep this.');
  await user.click(button('Save agent'));
  expect(screen.getByRole('alert')).toHaveTextContent('Storage offline');
  expect(name).toHaveValue('Editorial reviewer');
  expect(instructions).toHaveValue('Polish the manuscript. Keep this.');
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith({
    ...original.role,
    name: 'Editorial reviewer',
    prompt: 'Polish the manuscript. Keep this.',
  });
  await user.click(button('Save agent'));
  expect(beginSaveAgent).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText('Agent saved to library.')).toBeInTheDocument();
  expect(editor.getState().draft).toBe(before);
  expect(editor.getState().past).toEqual([]);
});

it('saves a copy’s description to the library with it', async () => {
  const save = vi.fn().mockResolvedValue({ ok: true });
  const description = 'Plans the chapters. Use it first.';
  mount({ beginSaveAgent: () => save }, origin, 'Team-only sentence', { description });
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: messages.Inspector.seatActions }));
  await user.click(await screen.findByRole('menuitem', { name: 'Save to library' }));
  await user.click(button('Save agent'));
  expect(LibraryAgentRole.parse(save.mock.calls[0]?.[0])).toEqual({
    ...original.role,
    name: 'Planner',
    description,
  });
});

it.each([
  {
    kind: 'preset',
    from: { kind: 'preset', presetId: 'architect' } as const,
    step: 'Compare the candidates.',
    expected: `Compare the candidates.\n\n${original.role.prompt}`,
  },
  { kind: 'handmade', from: null, step: '', expected: original.role.prompt },
])(
  'prefills and saves the reusable instructions of a $kind seat',
  async ({ from, step, expected }) => {
    const save = vi.fn().mockResolvedValue({ ok: true });
    const { user, editor, before } = mount({ beginSaveAgent: () => save }, from, step);
    await user.click(screen.getByRole('button', { name: messages.Inspector.seatActions }));
    await user.click(await screen.findByRole('menuitem', { name: 'Save to library' }));
    expect(within(screen.getByRole('dialog')).getByLabelText('Base instructions')).toHaveValue(
      expected,
    );
    await user.click(button('Save agent'));
    expect(save).toHaveBeenCalledWith({ ...original.role, name: 'Planner', prompt: expected });
    expect(editor.getState().draft).toBe(before);
  },
);

it.each([
  [origin, 'Source: Writer · r2'],
  [{ kind: 'preset', presetId: 'architect' } as const, 'Source: Design'],
  [{ ...origin, agentId: 'unknown' }, null],
  // A saved team from before the presets were the built-in agents: the row goes, the seat stays.
  [{ kind: 'preset', presetId: 'plan' } as const, null],
])(
  'only identifies a known origin from this project in advanced settings',
  async (from, expected) => {
    const { user } = mount({}, from);
    await user.click(screen.getByRole('button', { name: messages.Inspector.advanced }));
    if (expected) await waitFor(() => expect(screen.getByText(expected)).toBeVisible());
    else expect(screen.queryByText(/^Source:/)).toBeNull();
  },
);

it('shows each built-in agent with its duty and the names of its skills', async () => {
  const { user } = mount({ agentLibrary: { ...library, agents: [] } });
  await user.click(add());
  expect(tab(/Built-in/)).toHaveAttribute('aria-selected', 'true');
  const rows = within(screen.getByRole('dialog')).getAllByRole('button', {
    description: /./,
  });
  expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual(
    Object.values(messages.TeamTemplates.presets).map((preset) => preset.name),
  );
  // Without a resolved skill library the generated names still read, never a bare count.
  expect(button('Implementation')).toHaveAccessibleDescription(
    `${messages.TeamTemplates.presets.builder.duty}smallest-change · engineering-principles · failing-test-first · prove-it · corral-change-report`,
  );
  expect(button('Verification')).toHaveAccessibleDescription(
    `${messages.TeamTemplates.presets.verifier.duty}prove-it · measure-first · corral-verification · corral-review`,
  );
  expect(screen.getByRole('dialog')).not.toHaveTextContent(/\d skills/);
});
