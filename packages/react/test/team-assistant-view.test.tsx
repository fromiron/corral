import type { TeamAssistantResponse } from '@corral/contracts';
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

function setup({
  ask = null,
  existing = false,
  open = false,
  narrow = false,
  integrated = false,
  server = true,
}: {
  ask?: TeamAssistantHost['ask'];
  existing?: boolean;
  /** Null: nobody chose, so the place decides. */
  open?: boolean | null;
  narrow?: boolean;
  integrated?: boolean;
  /** False for the browser demo: there are no model settings to open. */
  server?: boolean;
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
    ...(server && { onConnectModel }),
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
  await user.click(connect);
  expect(onConnectModel).toHaveBeenCalledTimes(1);
});

it('cannot be pressed in the browser demo, which has no model settings to open', () => {
  setup({ open: true, server: false });
  expect(screen.queryByRole('textbox')).toBeNull();
  const off = button('Available on the local server');
  expect(off).toHaveAttribute('aria-disabled', 'true');
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
        pattern: 'single',
        criteria: ['Explain each step.'],
        roles: [{ slot: 'worker', name: 'Writer', duty: 'Write the guide.' }],
        finalApproval: false,
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
  expect(
    within(preview).getByText(/Flow: Writer · Final result: draft submitted by Writer/),
  ).toBeVisible();
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
