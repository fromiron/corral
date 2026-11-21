import { type TeamAssistantResponse, unusableTeamProposal } from '@corral/contracts';
import { compileDefinition, readAssistantAnswer } from '@corral/core';
import { Gate } from '@corral/testkit';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { expect, it, onTestFinished, vi } from 'vitest';
import { StudioStoresProvider } from '../src/context.tsx';
import { emptyDraft } from '../src/editor/model.ts';
import { createEditorStore } from '../src/editor/store.ts';
import en from '../src/messages/en.json' with { type: 'json' };
import { researchTeamDraft, sessionStore } from '../src/stories/fixtures.tsx';
import { TeamAssistant, type TeamAssistantHost } from '../src/team-editor/TeamAssistant.tsx';
import { TeamEditor } from '../src/team-editor/TeamEditor.tsx';
import { agent, agentName, choices, crew, notice, sequence } from './team-composition-fixtures.ts';

function setup({
  ask = null,
  existing = false,
  open = false,
  narrow = false,
  integrated = false,
  server = true,
  modelPending = false,
}: {
  ask?: TeamAssistantHost['ask'];
  existing?: boolean;
  /** Null: nobody chose, so the place decides. */
  open?: boolean | null;
  narrow?: boolean;
  integrated?: boolean;
  /** False for the browser demo: there are no model settings to open. */
  server?: boolean;
  /** The model list has not arrived yet. */
  modelPending?: boolean;
} = {}) {
  const editor = createEditorStore(existing ? researchTeamDraft() : emptyDraft());
  const session = sessionStore();
  let nextId = 0;
  const onConnectModel = vi.fn();
  const host: TeamAssistantHost = {
    ask,
    modelLabel: 'Test model',
    newOperationId: () => `assistant-${++nextId}`,
    wording: en.TeamDraft.wording,
    choices: async () => choices,
    ...(server && { onConnectModel }),
    ...(modelPending && { modelPending }),
  };
  const dock = (assistant: TeamAssistantHost) => (
    <IntlProvider locale="en" messages={en} timeZone="UTC">
      <StudioStoresProvider editor={editor} session={session}>
        {integrated ? (
          <TeamEditor
            editor={editor}
            view="composition"
            stacked={narrow}
            assistant={assistant}
            assistantStart={open === null ? undefined : { open }}
          />
        ) : (
          <TeamAssistant
            editor={editor}
            host={assistant}
            start={open === null ? undefined : { open }}
            onApplied={vi.fn()}
          />
        )}
      </StudioStoresProvider>
    </IntlProvider>
  );
  const { rerender } = render(dock(host));
  return {
    editor,
    host,
    onConnectModel,
    user: userEvent.setup(),
    disconnect: () => rerender(dock({ ...host, ask: null })),
    reconnect: () => rerender(dock(host)),
    withModel: (model: TeamAssistantHost['ask']) => rerender(dock({ ...host, ask: model })),
    listArrived: (model: TeamAssistantHost['ask']) =>
      rerender(dock({ ...host, ask: model, modelPending: false })),
  };
}

const button = (name: string | RegExp) => screen.getByRole('button', { name });
const field = (mode: 'create' | 'edit' = 'create') =>
  screen.getByRole('textbox', {
    name: mode === 'create' ? 'Request to build the team' : 'Request to edit the team',
  });
const question: TeamAssistantResponse = {
  reply: { kind: 'question', id: 'material', choices: ['person', 'team'] },
  model: 'Test model',
};

it('keeps the conversation and unsent input across collapse, returning focus to the entry and then the field', async () => {
  const ask = vi.fn().mockResolvedValue(question);
  const { user } = setup({ ask });
  await user.click(button('Build the team with AI'));
  expect(field()).toHaveFocus();
  expect(field()).toHaveAttribute('placeholder', 'Describe what this team should do');
  await user.click(button(/weekly neighborhood newsletter/i));
  expect(field()).toHaveValue('Make a weekly neighborhood newsletter.');
  expect(ask).not.toHaveBeenCalled();
  const transcript = screen.getByRole('log');
  Object.defineProperty(transcript, 'scrollHeight', { value: 500 });
  await user.click(button('Send'));
  const answer = await screen.findByRole('button', { name: 'I’ll provide the material' });
  expect(transcript).toContainElement(answer);
  expect(transcript.scrollTop).toBe(500);
  await user.type(field(), 'My unfinished note');
  await user.click(button('Answer in my own words'));
  expect(field()).toHaveFocus();
  expect(field()).toHaveValue('My unfinished note');
  expect(ask).toHaveBeenCalledTimes(1);
  await user.click(answer);
  expect(ask).toHaveBeenCalledTimes(2);
  expect(field()).toHaveValue('My unfinished note');
  await user.keyboard('{Escape}');
  expect(field()).toBeVisible();
  await user.click(button('Collapse'));
  expect(button('Build the team with AI')).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(field()).toHaveFocus();
  expect(field()).toHaveValue('My unfinished note');
  expect(screen.queryByRole('button', { name: 'I’ll provide the material' })).toBeNull();
  expect(
    within(screen.getByRole('log')).getByText('I’ll provide the material', { selector: 'p' }),
  ).toBeVisible();
  expect(
    within(screen.getByRole('log')).getByText('Make a weekly neighborhood newsletter.', {
      selector: 'p',
    }),
  ).toBeVisible();
  await user.clear(field());
  await user.keyboard('{Escape}');
  expect(button('Build the team with AI')).toHaveFocus();
  expect(ask).toHaveBeenCalledTimes(2);
});

it('quotes a question choice before sending and disables choices until cancel or completion', async () => {
  const gate = new Gate();
  const ask = vi
    .fn<NonNullable<TeamAssistantHost['ask']>>()
    .mockResolvedValueOnce(question)
    .mockImplementationOnce(async () => {
      await gate.wait();
      return question;
    })
    .mockResolvedValueOnce(question);
  const { user } = setup({ ask, open: true });
  await user.type(field(), 'Write a newsletter.{Enter}');
  const options = await screen.findByRole('group', { name: en.TeamAssistant.question.material });
  // The caption beside the input names the cost of a press; the options do not repeat it.
  expect(button('Recommend one')).toHaveAccessibleDescription('Test model · 1 request');
  expect(within(options).queryByText(/1 request/)).toBeNull();
  await user.type(field(), 'Save this note');
  await user.click(button('Recommend one'));
  expect(ask).toHaveBeenCalledTimes(2);
  for (const option of within(options).getAllByRole('button')) expect(option).toBeDisabled();
  fireEvent.click(button('I’ll provide the material'));
  expect(ask).toHaveBeenCalledTimes(2);
  await user.click(button('Cancel'));
  expect(button('Recommend one')).toBeEnabled();
  await user.click(button('Recommend one'));
  expect(ask).toHaveBeenCalledTimes(3);
  await act(async () => gate.open());
  expect(field()).toHaveValue('Save this note');
  expect(screen.queryByRole('group', { name: en.TeamAssistant.question.material })).toBeNull();
  expect(
    within(screen.getByRole('log')).getAllByText('Recommend one', { selector: 'p' }),
  ).toHaveLength(1);
});

it('turns the request into Connect a model on disconnect and brings the typed text back with the model', async () => {
  const ask = vi.fn().mockResolvedValue(question);
  const { user, disconnect, reconnect, onConnectModel } = setup({ ask, open: true });
  await user.type(field(), 'Write a newsletter.{Enter}');
  await screen.findByRole('group', { name: en.TeamAssistant.question.material });
  await user.type(field(), 'My unfinished note');
  disconnect();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByText(/1 request/)).toBeNull();
  expect(button(en.TeamAssistant.choice.team)).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  await user.click(button('Connect a model'));
  expect(onConnectModel).toHaveBeenCalledTimes(1);
  expect(ask).toHaveBeenCalledTimes(1);
  reconnect();
  expect(field()).toHaveValue('My unfinished note');
  expect(button(en.TeamAssistant.choice.team)).toBeEnabled();
});

it('offers one Connect a model control in place of the request when no model can run', async () => {
  const { user, onConnectModel } = setup({ open: true });
  expect(screen.queryByRole('textbox')).toBeNull();
  const connect = button('Connect a model');
  expect(connect).toHaveFocus();
  expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  expect(screen.queryByRole('button', { name: /weekly neighborhood newsletter/i })).toBeNull();
  expect(screen.queryByText(/No model/i)).toBeNull();
  expect(screen.queryByRole('button', { name: /local example/i })).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Connect a model' })).toHaveLength(1);
  // It opens the model settings, so it points like the kit's buttons.
  expect(connect).toHaveClass('cursor-pointer');
  await user.click(connect);
  expect(onConnectModel).toHaveBeenCalledTimes(1);
});

it('cannot be pressed in the browser demo, which has no model settings to open', () => {
  setup({ open: true, server: false });
  expect(screen.queryByRole('textbox')).toBeNull();
  const off = button('Available on the local server');
  expect(off).toHaveAttribute('aria-disabled', 'true');
  expect(off).toHaveClass('cursor-default');
  expect(off).not.toHaveClass('cursor-pointer');
  expect(off).toHaveFocus();
  expect(screen.queryByRole('button', { name: 'Connect a model' })).toBeNull();
});

it('keeps the four edit choices without a model, taking a new goal in the input they open', async () => {
  const { user, editor } = setup({ existing: true, open: true });
  expect(screen.queryByRole('textbox')).toBeNull();
  await user.click(button('Who submits the result?'));
  expect(screen.getByRole('log')).toHaveTextContent(/submits “draft”/);
  await user.click(button('Change the goal'));
  expect(field('edit')).toHaveFocus();
  expect(button('Send')).toHaveAttribute('aria-description', 'No model call');
  await user.type(field('edit'), 'Compare three libraries.{Enter}');
  await user.click(button('Apply to draft'));
  expect(editor.getState().draft.definition.input.brief).toBe('Compare three libraries.');
  await user.click(button('Edit the team with AI'));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(button('Connect a model')).toHaveFocus();
});

it('does not send during Korean composition, duplicate a pending request, or show its late answer after cancel', async () => {
  const gate = new Gate();
  const ask = vi.fn<NonNullable<TeamAssistantHost['ask']>>(async () => {
    await gate.wait();
    return question;
  });
  const { user, editor } = setup({ ask, open: true });
  expect(screen.getByText('Test model')).toBeVisible();
  fireEvent.compositionStart(field());
  fireEvent.change(field(), { target: { value: '동네 소식지' } });
  fireEvent.keyDown(field(), { key: 'Enter', keyCode: 229, isComposing: true });
  expect(ask).not.toHaveBeenCalled();
  fireEvent.compositionEnd(field());
  await user.keyboard('{Enter}{Enter}');
  expect(ask).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  await user.click(button('Cancel'));
  expect(ask.mock.calls[0]?.[1].aborted).toBe(true);
  await act(async () => gate.open());
  expect(screen.queryByRole('button', { name: 'I’ll provide the material' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Apply to draft' })).toBeNull();
  expect(editor.getState().past).toHaveLength(0);
});

it('announces the actual new response politely and does not show an apply button for a description', async () => {
  const ask = vi.fn();
  const { user, editor } = setup({ existing: true, ask, open: true });
  const dock = screen.getByRole('region', { name: 'Edit the team with AI' });
  expect(field('edit')).toHaveAttribute('placeholder', 'Describe what to change');
  const live = dock.querySelector('[aria-live="polite"]');
  expect(live).toBeInTheDocument();
  const before = editor.getState().draft;
  await user.click(within(dock).getByRole('button', { name: 'Who submits the result?' }));
  expect(live?.textContent?.trim()).toBeTruthy();
  const producer = before.definition.nodes.find((n) => n.id === 'write');
  expect(producer).toBeDefined();
  expect(live).toHaveTextContent(producer?.label ?? 'Writer');
  expect(screen.queryByRole('button', { name: 'Apply to draft' })).toBeNull();
  expect(editor.getState().draft).toBe(before);
  expect(ask).not.toHaveBeenCalled();
});

it('previews the complete old and new goals as separate, four-line reading blocks', async () => {
  const { user, editor } = setup({ existing: true, open: true });
  const before = editor.getState().draft.definition.input.brief;
  const after = 'Find local events and list verified dates, times, prices and accessible routes.\n'
    .repeat(6)
    .trim();
  await user.click(button('Change the goal'));
  fireEvent.change(field('edit'), { target: { value: after } });
  await user.click(button('Send'));
  const preview = screen.getByRole('region', { name: 'Proposed changes' });
  expect(
    within(preview)
      .getAllByRole('term')
      .map((term) => term.textContent),
  ).toEqual(['Before', 'After']);
  const values = within(preview).getAllByRole('definition');
  expect(values.map((node) => node.textContent)).toEqual([before, after]);
  expect(values.map((node) => node.title)).toEqual([before, after]);
  for (const node of values) expect(node).toHaveClass('line-clamp-4');
  expect(preview).not.toHaveTextContent('→');
  await user.click(button('Apply to draft'));
  expect(editor.getState().draft.definition.input.brief).toBe(after);
});

it('prevents applying a stale proposal; retry keeps the manual change and recomputes without a model', async () => {
  const ask = vi.fn();
  const { user, editor } = setup({ existing: true, ask, open: true });
  await user.click(button('Add advice on demand'));
  expect(button('Apply to draft')).toBeEnabled();
  act(() => editor.getState().setName('My edit'));
  expect(screen.getByText('The draft changed')).toBeVisible();
  expect(button('Apply to draft')).toBeDisabled();
  await user.click(button('Propose again'));
  await user.click(button('Apply to draft'));
  expect(editor.getState().draft.definition.name).toBe('My edit');
  expect(editor.getState().draft.definition.sharedOutrider).toBeDefined();
  expect(ask).not.toHaveBeenCalled();
});

it('opens a named narrow sheet by keyboard, previews a model proposal and hands focus to its first real row after applying', async () => {
  const width = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(360);
  onTestFinished(() => {
    width.mockRestore();
  });
  const ask = vi.fn<NonNullable<TeamAssistantHost['ask']>>().mockResolvedValue({
    model: 'Test model',
    reply: {
      kind: 'plan',
      plan: {
        name: 'Guide',
        brief: 'Write this guide.',
        criteria: ['Explain each step.'],
        seats: [
          { id: 'w', agent: agent('writer'), name: 'Guide writer', duty: 'Write the guide.' },
        ],
        flow: [{ seat: 'w' }],
      },
      reason: 'One writer is enough.',
    },
  });
  const { user, editor } = setup({ ask, integrated: true, narrow: true });
  const entry = button('Build the team with AI');
  entry.focus();
  await user.keyboard('{Enter}');
  const dialog = await screen.findByRole('dialog', { name: 'Build the team with AI' });
  expect(within(dialog).getByRole('region', { name: 'Build the team with AI' })).toBeVisible();
  await waitFor(() => expect(field()).toHaveFocus());
  await user.keyboard('{Escape}');
  await waitFor(() => expect(entry).toHaveFocus());
  await user.keyboard('{Enter}');
  await waitFor(() => expect(field()).toHaveFocus());
  const transcript = within(screen.getByRole('dialog')).getByRole('log');
  Object.defineProperty(transcript, 'scrollHeight', { value: 600 });
  await user.keyboard('Use one writer to write this guide.{Enter}');
  const preview = await screen.findByRole('region', { name: 'Proposal from Test model' });
  expect(within(preview).getByText('Guide writer')).toBeVisible();
  expect(within(preview).getByText(/submitted by Guide writer/)).toBeVisible();
  const turn = within(transcript).getByText('Use one writer to write this guide.', {
    selector: 'p',
  });
  expect(turn.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(transcript).not.toContainElement(field());
  expect(transcript).toHaveClass('overflow-y-auto');
  expect(transcript.scrollTop).toBe(600);
  const apply = button('Apply to draft');
  // From the request field the whole sheet, including its preview controls, is reachable by Tab.
  for (let i = 0; i < 40 && document.activeElement !== apply; i++) await user.tab();
  expect(apply).toHaveFocus();
  await user.keyboard('{Enter}');
  const id = editor.getState().draft.definition.nodes.find((n) => n.type === 'agent')?.id;
  expect(id).toBeTruthy();
  await waitFor(() =>
    expect(document.querySelector(`[data-composition-node="${id}"]`)).toHaveFocus(),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(editor.getState().past).toHaveLength(1);
});

it('leaves the focus alone when a column that opened by itself gets its model after mounting', () => {
  const width = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1600);
  onTestFinished(() => {
    width.mockRestore();
  });
  // Profiles load after the editor: the first render has no model.
  const { withModel } = setup({ existing: true, integrated: true, open: null });
  expect(button('Connect a model')).not.toHaveFocus();
  withModel(vi.fn());
  expect(field('edit')).toBeVisible();
  expect(field('edit')).not.toHaveFocus();
  expect(document.body).toHaveFocus();
});

it('says nothing about models while the model list has not arrived, and sends nothing', async () => {
  const { user, listArrived } = setup({ open: true, modelPending: true });
  expect(screen.queryByRole('button', { name: 'Connect a model' })).toBeNull();
  expect(screen.queryByText(/request|model/i, { selector: 'span' })).toBeNull();
  await user.type(field(), 'Write a notice.');
  expect(button('Send')).toBeDisabled();
  expect(button('Send')).not.toHaveAttribute('aria-description');
  await user.keyboard('{Enter}');
  expect(field()).toHaveValue('Write a notice.');
  expect(screen.getByRole('log')).not.toHaveTextContent('Write a notice.');
  // The list arrives empty: now the request is switched off.
  listArrived(null);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(button('Connect a model')).toBeVisible();
});

it('turns the waiting input into a working one when the list brings a model', async () => {
  const ask = vi.fn().mockResolvedValue(question);
  const { user, listArrived } = setup({ open: true, modelPending: true });
  await user.type(field(), 'Write a newsletter.');
  listArrived(ask);
  expect(button('Send')).toBeEnabled();
  await user.click(button('Send'));
  expect(ask).toHaveBeenCalledTimes(1);
});

/** A seat row's name: its first strong text. */
const seatName = (row: HTMLElement) => row.querySelector('[data-seat-name]')?.textContent;

const planned = (plan: typeof crew, reason: string): TeamAssistantResponse => ({
  model: 'Test model',
  reply: { kind: 'plan', plan, reason },
});

it('shows a composed team as its seats in their flow, with the result, the reason and no ids', async () => {
  const ask = vi
    .fn<NonNullable<TeamAssistantHost['ask']>>()
    .mockResolvedValue(
      planned(crew, 'Two checks in parallel find more, and a final check passes the summary.'),
    );
  const { user, editor } = setup({ ask, open: true });
  await user.type(field(), 'Review this pull request for security issues.{Enter}');
  const preview = await screen.findByRole('region', { name: 'Proposal from Test model' });
  expect(within(preview).getByRole('heading', { name: 'Security review' })).toBeVisible();
  // Each seat once, with the agent it uses and its duty in one line.
  const seat = (name: string) => within(preview).getByText(name).closest('li');
  expect(seat('Scope')).toHaveTextContent(agentName('investigator'));
  expect(seat('Scope')).toHaveTextContent('List what changed.');
  expect(within(preview).getAllByText('Scope')).toHaveLength(1);
  // Work side by side, and a loop with its rounds and its judge.
  const together = within(preview).getByRole('list', { name: en.TeamEditor.composition.parallel });
  expect(within(together).getAllByRole('listitem').map(seatName)).toEqual([
    'Injection check',
    'Secrets check',
  ]);
  const loop = within(preview).getByRole('list', { name: 'Up to 2 rounds' });
  expect(within(loop).getAllByRole('listitem').map(seatName)).toEqual(['Summary', 'Final check']);
  expect(seat('Final check')).toHaveTextContent('Judge');
  expect(seat('Summary')).not.toHaveTextContent('Judge');
  expect(within(preview).getByText(/submitted by Summary/)).toBeVisible();
  expect(
    within(preview).getByText(
      'Two checks in parallel find more, and a final check passes the summary.',
    ),
  ).toBeVisible();
  // A product screen: no catalog or node ids, no pattern to choose, nothing JSON-like.
  expect(preview).not.toHaveTextContent(/\b[as]\d+\b|seat_|loop_|join_|[{}]/);
  expect(within(preview).queryByRole('radiogroup')).toBeNull();
  // Observation stays off until the person turns it on.
  await user.click(within(preview).getByRole('button', { name: 'Criteria and settings' }));
  await waitFor(() =>
    expect(within(preview).getByText(/Each finding names the file and line\./)).toBeVisible(),
  );
  expect(
    within(preview).getByRole('switch', { name: en.TeamEditor.sharedOutrider.observe }),
  ).not.toBeChecked();
  await user.click(button('Apply to draft'));
  const { definition } = editor.getState().draft;
  expect(definition.nodes.filter((n) => n.type === 'agent').map((n) => n.label)).toEqual([
    'Scope',
    'Injection check',
    'Secrets check',
    'Summary',
    'Final check',
  ]);
  expect(definition.sharedOutrider).toBeUndefined();
});

it('refines a proposal in the conversation: the new one replaces it and the earlier one stays, unappliable', async () => {
  const ask = vi
    .fn<NonNullable<TeamAssistantHost['ask']>>()
    .mockResolvedValueOnce(planned(sequence, 'A cause, a fix and a note.'))
    .mockResolvedValueOnce(planned(crew, 'Security needs two checks.'));
  const { user } = setup({ ask, open: true });
  await user.type(field(), 'Fix the login bug.{Enter}');
  const first = await screen.findByRole('region', { name: 'Proposal from Test model' });
  // An added skill is shown with its seat.
  expect(within(first).getByText('Release note').closest('li')).toHaveTextContent('doc-writing');
  await user.type(field(), 'Check it for security issues too.{Enter}');
  await waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
  expect(ask.mock.calls[1]?.[0]).toMatchObject({ mode: 'create', proposal: sequence });
  const shown = await screen.findByRole('region', { name: 'Proposal from Test model' });
  expect(within(shown).getByRole('heading', { name: 'Security review' })).toBeVisible();
  // The earlier proposal stays in the conversation as it was, without a way to apply it.
  const log = screen.getByRole('log');
  const earlier = within(log).getByRole('button', { name: en.TeamAssistant.earlier });
  expect(shown).not.toContainElement(earlier);
  await user.click(earlier);
  await waitFor(() => expect(within(log).getByText('Cause finder')).toBeVisible());
  expect(screen.getAllByRole('button', { name: 'Apply to draft' })).toEqual([
    within(shown).getByRole('button', { name: 'Apply to draft' }),
  ]);
});

/**
 * The endpoint as it reads a model's answer (core `readAssistantAnswer`): lenient notation is
 * normalised against the sent catalog, and an unusable answer is the server's failure.
 */
const served =
  (answer: unknown): NonNullable<TeamAssistantHost['ask']> =>
  async (request) => {
    const read = readAssistantAnswer(JSON.stringify(answer), request);
    if ('problem' in read)
      throw Object.assign(new Error(unusableTeamProposal(read.problem)), {
        code: 'MODEL_UNAVAILABLE',
      });
    return { reply: read.reply, model: 'Test model' };
  };

const strictErrors = (definition: Parameters<typeof compileDefinition>[0]) =>
  compileDefinition(definition).diagnostics.filter((issue) => issue.severity === 'error');

it('shows and applies only the added skills the catalog lists and the agent does not have yet', async () => {
  const answer = {
    kind: 'plan',
    reason: 'One writer.',
    plan: {
      ...notice,
      seats: [{ ...notice.seats[0], skills: ['doc-writing', 'no-such-skill', 'break-it'] }],
    },
  };
  const { user, editor } = setup({ ask: served(answer), open: true });
  await user.type(field(), 'Write a notice.{Enter}');
  const preview = await screen.findByRole('region', { name: 'Proposal from Test model' });
  const seat = within(preview).getByText('Notice writer').closest('li');
  expect(seat).toHaveTextContent('break-it');
  expect(seat).not.toHaveTextContent('doc-writing');
  expect(seat).not.toHaveTextContent('no-such-skill');
  await user.click(button('Apply to draft'));
  const { definition } = editor.getState().draft;
  const skills = (definition.roles[0]?.skills ?? []).map((ref) => ref.entry);
  expect(skills.filter((entry) => entry.includes('break-it'))).toHaveLength(1);
  expect(skills.filter((entry) => entry.includes('doc-writing'))).toHaveLength(1);
  expect(strictErrors(definition)).toEqual([]);
});

it('shows, applies and compiles a team that starts with work in parallel', async () => {
  const answer = {
    kind: 'plan',
    reason: 'Two checks first, then a summary.',
    plan: {
      ...crew,
      seats: crew.seats.filter((seat) => ['x', 'y', 'w'].includes(seat.id)),
      flow: [{ parallel: ['x', 'y'] }, { seat: 'w' }],
    },
  };
  const { user, editor } = setup({ ask: served(answer), open: true, integrated: true });
  await user.type(field(), 'Check this pull request.{Enter}');
  const preview = await screen.findByRole('region', { name: 'Proposal from Test model' });
  const together = within(preview).getByRole('list', { name: en.TeamEditor.composition.parallel });
  expect(within(together).getAllByRole('listitem').map(seatName)).toEqual([
    'Injection check',
    'Secrets check',
  ]);
  expect(within(preview).getByText(/submitted by Summary/)).toBeVisible();
  await user.click(button('Apply to draft'));
  const { definition } = editor.getState().draft;
  expect(strictErrors(definition)).toEqual([]);
  expect(definition.nodes.filter((n) => n.type === 'agent').map((n) => n.label)).toEqual([
    'Injection check',
    'Secrets check',
    'Summary',
  ]);
  // The group's Team is named as a Team, not after the Join inside it.
  expect(definition.nodes.find((n) => n.type === 'team')?.label).toBe(en.TeamEditor.kinds.team);
  expect(definition.nodes.filter((n) => n.label === en.TeamEditor.kinds.join)).toHaveLength(1);
  // The composition list shows the two seats and the summary after them.
  const list = screen.getByRole('list', { name: 'Team composition' });
  for (const name of ['Injection check', 'Secrets check', 'Summary'])
    expect(within(list).getAllByText(name, { exact: true }).length).toBeGreaterThan(0);
});

it('shows each result of a team that ends in parallel work on its own line, and applies one result each', async () => {
  const answer = {
    kind: 'plan',
    reason: 'Two checks, each reported.',
    plan: {
      ...crew,
      seats: crew.seats.slice(0, 3),
      flow: [{ seat: 'scope' }, { parallel: ['x', 'y'] }],
    },
  };
  const { user, editor } = setup({ ask: served(answer), open: true });
  await user.type(field(), 'Check this pull request.{Enter}');
  const preview = await screen.findByRole('region', { name: 'Proposal from Test model' });
  const results = within(preview).getAllByText(/submitted by/);
  expect(results.map((line) => line.textContent?.replace(/^.* submitted by /, ''))).toEqual([
    'Injection check',
    'Secrets check',
  ]);
  await user.click(button('Apply to draft'));
  const { definition } = editor.getState().draft;
  const output = definition.nodes.find((node) => node.type === 'output');
  const labels = new Map(definition.nodes.map((node) => [node.id, node.label]));
  expect(
    output?.type === 'output'
      ? output.inputBindings.map((binding) =>
          binding.kind === 'task_output' ? labels.get(binding.sourceNodeId ?? '') : binding.kind,
        )
      : [],
  ).toEqual(['Injection check', 'Secrets check']);
  expect(strictErrors(definition)).toEqual([]);
});

it('names the model once for a new team: beside the input, not again on the proposal', async () => {
  const ask = vi
    .fn<NonNullable<TeamAssistantHost['ask']>>()
    .mockResolvedValue(planned(sequence, 'A cause, a fix and a note.'));
  const { user } = setup({ ask, open: true });
  await user.type(field(), 'Fix the login bug.{Enter}');
  const preview = await screen.findByRole('region', { name: 'Proposal from Test model' });
  const title = within(preview).getByRole('heading', { name: 'Fix the login bug' });
  expect(title.parentElement).toHaveTextContent(/^Fix the login bug$/);
  expect(preview).not.toHaveTextContent('Test model');
  expect(screen.getByText('Test model', { selector: 'span' })).toBeVisible();
});

it('keeps the model name on an edit it proposed, apart from a change one of the choices made', async () => {
  const ask = vi.fn<NonNullable<TeamAssistantHost['ask']>>().mockResolvedValue({
    model: 'Test model',
    reply: { kind: 'edits', edits: [{ kind: 'add_shared_advice' }], reason: 'Advice on demand.' },
  });
  const { user } = setup({ existing: true, ask, open: true });
  await user.type(field('edit'), 'Let the writer ask for advice.{Enter}');
  const preview = await screen.findByRole('region', { name: 'Proposal from Test model' });
  expect(within(preview).getByText('Proposal from Test model')).toBeVisible();
});

it('turns Retry and Propose again off when no model is left to ask', async () => {
  const ask = vi
    .fn<NonNullable<TeamAssistantHost['ask']>>()
    .mockResolvedValueOnce(planned(sequence, 'A cause, a fix and a note.'))
    .mockRejectedValueOnce(
      Object.assign(new Error('The model did not return a usable team proposal.'), {
        code: 'MODEL_UNAVAILABLE',
      }),
    );
  const { user, disconnect, reconnect } = setup({ ask, open: true });
  await user.type(field(), 'Fix the login bug.{Enter}');
  await screen.findByRole('region', { name: 'Proposal from Test model' });
  disconnect();
  expect(button('Propose again')).toBeDisabled();
  reconnect();
  await user.click(button('Propose again'));
  await screen.findByRole('alert');
  disconnect();
  expect(button(en.TeamDraft.retry)).toBeDisabled();
  expect(ask).toHaveBeenCalledTimes(2);
});

it('keeps Propose again for a change one of the choices made, which needs no model', async () => {
  const { user } = setup({ existing: true, open: true });
  await user.click(button('Add advice on demand'));
  expect(button('Propose again')).toBeEnabled();
});
