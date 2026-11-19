import { type AgentRole, isWorkAgent, type LibraryAgent } from '@corral/contracts';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import { StudioStoresProvider } from '../src/context.tsx';
import { emptyDraft } from '../src/editor/model.ts';
import { createEditorStore } from '../src/editor/store.ts';
import messages from '../src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../src/stories/fixtures.tsx';
import { addAgent, setStepInstruction } from '../src/team-editor/commands.ts';
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
function mount(props: Partial<TeamEditorProps> = {}, from: AgentRole['origin'] = origin) {
  const seat = addAgent(
    emptyDraft(),
    { role: { ...original.role, name: 'Planner' }, origin: from },
    { kind: 'empty' },
  );
  if (!seat.ok || !seat.nodeId) throw Error('missing seat');
  const task = setStepInstruction(seat.draft, seat.nodeId, 'Team-only sentence');
  if (!task.ok) throw Error('missing task');
  const editor = createEditorStore(task.draft);
  render(
    <IntlProvider locale="en" messages={messages}>
      <StudioStoresProvider editor={editor} session={sessionStore()}>
        <TeamEditor view="composition" editor={editor} agentLibrary={library} {...props} />
      </StudioStoresProvider>
    </IntlProvider>,
  );
  const nodeId = seat.nodeId;
  act(() => editor.getState().select(nodeId));
  return { editor, before: task.draft, user: userEvent.setup() };
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

it('searches only the active group, opens built-in for an empty library, and restores focus on cancel', async () => {
  const { editor, user, before } = mount({ agentLibrary: { ...library, agents: [] } });
  const opener = add();
  await user.click(opener);
  expect(tab(/Built-in/)).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('dialog')).not.toHaveTextContent('Project: Harbor');
  await user.click(tab(/My agents/));
  expect(screen.getByRole('dialog')).toHaveTextContent('Project: Harbor');
  await user.click(tab(/Other teams/));
  expect(screen.getByRole('dialog')).not.toHaveTextContent('Project: Harbor');
  await user.click(tab(/Built-in/));
  await user.type(search(), 'writing');
  expect(button(/^Writing/)).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Plan' })).toBeNull();
  fireEvent.keyDown(search(), { key: 'Escape', isComposing: true });
  expect(search()).toBeVisible();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(opener).toHaveFocus());
  expect(editor.getState().draft).toBe(before);
  expect(editor.getState().past).toEqual([]);
  await user.click(opener);
  await user.click(button(/^Writing/));
  expect(editor.getState().draft.definition.roles.at(-1)?.origin).toEqual({
    kind: 'preset',
    presetId: 'write',
  });
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

it('shows loading, distinct descriptions and resolved skill names rather than an empty group', async () => {
  const skills = [{ resourceHash: 'a'.repeat(64), entry: 'writing/SKILL.md' }];
  const { user } = mount({
    agentLibrary: { ...library, status: 'loading' },
    teams: [
      {
        corralId: 'harbor',
        name: 'Harbor',
        definitionRevision: 1,
        roles: [
          { ...original.role, id: 'writer', skills },
          { ...original.role, id: 'notes', prompt: 'Check footnotes.' },
          {
            ...original.role,
            id: 'advisor',
            name: 'Observer',
            allowedCollaborationTools: ['advise'],
          },
        ],
      },
    ],
    skillLabel: () => 'House style',
  });
  await user.click(add());
  expect(within(screen.getByRole('dialog')).getByRole('status')).toHaveTextContent(
    'Loading agents…',
  );
  await user.click(tab(/Other teams/));
  const rows = within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Writer' });
  expect(rows[0]).toHaveAccessibleDescription(/Harbor.*manuscript.*House style/);
  expect(rows[1]).toHaveAccessibleDescription(/Check footnotes/);
  expect(screen.queryByRole('button', { name: 'Observer' })).toBeNull();
  await user.type(search(), 'footnotes');
  expect(button('Writer')).toHaveAccessibleDescription(/Check footnotes/);
});

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
  expect(screen.getByText(/Nothing changes/)).toBeVisible();
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

it.each([
  [origin, 'Source: Writer · r2'],
  [{ kind: 'preset', presetId: 'plan' } as const, 'Source: Plan'],
  [{ ...origin, agentId: 'unknown' }, null],
])(
  'only identifies a known origin from this project in advanced settings',
  async (from, expected) => {
    const { user } = mount({}, from);
    await user.click(screen.getByRole('button', { name: messages.Inspector.advanced }));
    if (expected) await waitFor(() => expect(screen.getByText(expected)).toBeVisible());
    else expect(screen.queryByText(/^Source:/)).toBeNull();
  },
);
