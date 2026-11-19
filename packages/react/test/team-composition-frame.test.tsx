import { CorralDefinition } from '@corral/contracts';
import { type Diagnostic, teamTemplate } from '@corral/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useState } from 'react';
import { IntlProvider } from 'use-intl';
import { afterAll, assert, beforeAll, expect, it, vi } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json';
import { StudioStoresProvider } from '../src/context.tsx';
import { draftFromDefinition, emptyDraft } from '../src/editor/model.ts';
import { createEditorStore } from '../src/editor/store.ts';
import messages from '../src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../src/stories/fixtures.tsx';
import { patchNode } from '../src/team-editor/commands.ts';
import { TeamEditor, type TeamEditorNavigation } from '../src/team-editor/TeamEditor.tsx';

beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
});
afterAll(() => vi.restoreAllMocks());

const research = () => draftFromDefinition(CorralDefinition.parse(researchTeam));
function mount(draft = research(), stacked = false, diagnostics?: readonly Diagnostic[]) {
  const editor = createEditorStore(draft);
  const session = sessionStore();
  const nav = createRef<TeamEditorNavigation>();
  function Host() {
    const [view, setView] = useState<'composition' | 'graph'>('composition');
    return (
      <IntlProvider locale="en" messages={messages}>
        <StudioStoresProvider editor={editor} session={session}>
          <button type="button" onClick={() => setView(view === 'graph' ? 'composition' : 'graph')}>
            Switch view
          </button>
          <TeamEditor
            ref={nav}
            editor={editor}
            {...(diagnostics ? { diagnostics } : {})}
            view={view}
            onViewChange={setView}
            stacked={stacked}
          />
        </StudioStoresProvider>
      </IntlProvider>
    );
  }
  render(<Host />);
  return { editor, nav, user: userEvent.setup() };
}
const findRow = (id: string) =>
  document.querySelector<HTMLElement>(`[data-composition-node="${id}"]`);
const findCard = (id: string) =>
  document.querySelector<HTMLElement>(`[data-team-canvas] [data-node="${id}"]`);
function required<T>(item: T | undefined | null): T {
  assert(item != null);
  return item;
}
const row = (id: string) => required(findRow(id));
const card = (id: string) => required(findCard(id));
const sheet = () => screen.getByRole('complementary', { name: messages.TeamEditor.inspector });
const switchView = () => screen.getByRole('button', { name: 'Switch view' });

it('shares selection and collapsed boxes without modifying the draft, undo or the mounted graph', async () => {
  const draft = research();
  const { editor, user } = mount(draft);
  const canvas = document.querySelector('[data-team-canvas]');
  expect(screen.queryByRole('application', { name: messages.TeamEditor.canvas })).toBeNull();
  expect(
    within(sheet()).getByRole('heading', { name: messages.TeamEditor.teamSettings }),
  ).toBeVisible();
  await user.click(row('research'));
  await user.click(screen.getByRole('button', { name: /^Collapse / }));
  expect(findRow('write')).toBeNull();
  await user.click(switchView());
  expect(screen.getByRole('application', { name: messages.TeamEditor.canvas })).toBe(canvas);
  expect(card('research')).toHaveAttribute('aria-pressed', 'true');
  expect(findCard('write')).toBeNull();
  await user.click(card('approval'));
  await user.click(switchView());
  expect(row('approval')).toHaveAttribute('aria-pressed', 'true');
  expect(editor.getState().draft).toBe(draft);
  expect(editor.getState().past).toEqual([]);
});

it('adds the first agent and its bound result together; inserting another offers its output without replacing the first', async () => {
  const draft = emptyDraft();
  const { editor, user } = mount(draft);
  const add = () => screen.getByRole('button', { name: /^Add agent$/i });
  await user.click(add());
  await user.keyboard('{Escape}');
  expect(editor.getState().draft).toBe(draft);
  expect(editor.getState().past).toEqual([]);
  await user.click(add());
  await user.click(await screen.findByRole('button', { name: /^Implementation/ }));
  const first = editor.getState().draft;
  expect(first.definition.nodes).toMatchObject([
    { type: 'agent', label: 'Implementation' },
    { type: 'output', inputBindings: [{ sourceNodeId: first.definition.nodes[0]?.id }] },
  ]);
  act(() => editor.getState().undo());
  expect(editor.getState().draft).toBe(draft);
  act(() => editor.getState().redo());
  await user.click(add());
  await user.click(await screen.findByRole('button', { name: /^Writing/ }));
  const inserted = editor.getState().draft;
  const output = () => editor.getState().draft.definition.nodes.find((n) => n.type === 'output');
  expect(output()?.inputBindings[0]?.sourceNodeId).toBe(first.definition.nodes[0]?.id);
  const writer = required(inserted.definition.nodes.find((n) => n.label === 'Writing'));
  const offer = within(required(row(writer.id).closest('li'))).getByRole('button', {
    name: 'Use this step’s result',
  });
  await user.click(offer);
  expect(output()?.inputBindings[0]?.sourceNodeId).toBe(writer.id);
  act(() => editor.getState().undo());
  expect(editor.getState().draft).toBe(inserted);
  act(() => editor.getState().undo());
  expect(editor.getState().draft).toBe(first);
});

function reviewDraft() {
  return draftFromDefinition(
    teamTemplate('plan-implement-review', 'review-team', {
      name: 'Review team',
      brief: 'Prepare a report.',
      criteria: ['Reviewed'],
      roles: messages.TeamTemplates.presets,
      labels: { loop: 'Review loop', decision: 'Verdict', join: 'Gather', output: 'Report' },
    }),
  );
}

it('adds a preset before the review Loop’s final result without leaving composition or asking for placement', async () => {
  const draft = reviewDraft();
  const { user, editor } = mount(draft);
  await user.click(screen.getByRole('button', { name: 'Add agent' }));
  const dialog = screen.getByRole('dialog', { name: 'Add agent' });
  await user.click(within(dialog).getByRole('button', { name: 'Writing' }));
  const { definition } = editor.getState().draft;
  const seat = required(definition.nodes.find((node) => node.label === 'Writing'));
  expect(row(seat.id)).toBeVisible();
  expect(row(seat.id)).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('application', { name: messages.TeamEditor.canvas })).toBeNull();
  expect(screen.queryByText(/Choose where to add the agent/)).toBeNull();
  expect(definition.nodes).toHaveLength(draft.definition.nodes.length + 1);
  expect(definition.controlEdges.filter((edge) => edge.target === 'output')).toMatchObject([
    { source: seat.id, sourcePort: 'out' },
  ]);
  expect(definition.controlEdges.filter((edge) => edge.target === seat.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ source: 'review_loop', sourcePort: 'next' }),
      expect.objectContaining({ source: 'review_loop', sourcePort: 'exhausted' }),
    ]),
  );
  expect(editor.getState().past).toEqual([draft]);
});

it('adds to Not connected when outputs compete and clears the polite guidance on edit or selection', async () => {
  const draft = reviewDraft();
  const output = required(draft.definition.nodes.find((node) => node.type === 'output'));
  draft.definition.nodes.push({ ...output, id: 'appendix', label: 'Appendix' });
  const { user, editor } = mount(draft);
  const notice = 'Agent added without a connection.';
  for (const name of ['Writing', 'Research']) {
    await user.click(screen.getByRole('button', { name: 'Add agent' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name }));
    const disconnected = screen.getByRole('list', { name: 'Not connected' });
    const seat = required(editor.getState().draft.definition.nodes.find((n) => n.label === name));
    expect(disconnected).toContainElement(row(seat.id));
    expect(row(seat.id)).toHaveAttribute('aria-pressed', 'true');
    expect(editor.getState().draft.definition.controlEdges).toEqual(draft.definition.controlEdges);
    expect(screen.getByText(notice)).toHaveAttribute('role', 'status');
    expect(screen.getByText(notice)).not.toHaveClass('text-destructive');
    if (name === 'Writing') await user.click(row('plan'));
    else {
      act(() => {
        const state = editor.getState();
        state.applyDraft(patchNode(state.draft, seat.id, { label: 'Researcher' }));
      });
    }
    expect(screen.queryByText(notice)).toBeNull();
  }
});

it('drills into a narrow detail, restores focus to the same row and leaves the list scroll alone', async () => {
  const { user, editor } = mount(research(), true);
  const opener = row('write');
  const scroller = required(opener.closest<HTMLElement>('[data-composition-scroll]'));
  scroller.scrollTop = 240;
  expect(screen.queryByRole('complementary', { name: messages.TeamEditor.inspector })).toBeNull();
  await user.click(opener);
  expect(opener).not.toBeVisible();
  expect(sheet()).toBeVisible();
  await user.click(screen.getByRole('button', { name: /^Team composition$/i }));
  expect(opener).toHaveFocus();
  expect(scroller.scrollTop).toBe(240);
  await user.keyboard('{Enter}{Escape}');
  expect(opener).toHaveFocus();
  expect(opener).toHaveAttribute('aria-pressed', 'true');
  expect(editor.getState().canUndo).toBe(false);
  await user.keyboard('{Delete}');
  expect(editor.getState().draft.definition.nodes.some((n) => n.id === 'write')).toBe(false);
  expect(editor.getState().past).toHaveLength(1);
});

it('opens the brief from navigation while stacked and can return without changing the draft', async () => {
  const { nav, editor } = mount(research(), true);
  act(() => nav.current?.editBrief());
  const brief = required(sheet().querySelector('[data-team-brief]'));
  expect(brief).toHaveFocus();
  fireEvent.keyDown(brief, { key: 'Escape', isComposing: true });
  expect(sheet()).toBeVisible();
  fireEvent.keyDown(brief, { key: 'Escape' });
  expect(screen.queryByRole('complementary', { name: messages.TeamEditor.inspector })).toBeNull();
  expect(editor.getState().past).toEqual([]);
});

it('keeps a manually panned graph while hidden and reveals a changed selection only after returning', async () => {
  const { user, nav } = mount();
  await user.click(switchView());
  const graph = screen.getByRole('application', { name: messages.TeamEditor.canvas });
  Object.defineProperties(graph, {
    clientWidth: { get: () => (graph.closest('[hidden]') ? 0 : 1200) },
    clientHeight: { get: () => (graph.closest('[hidden]') ? 0 : 800) },
  });
  const stage = required(graph.querySelector<HTMLElement>('[data-graph-stage]'));
  const transform = () => stage.style.transform;
  await user.click(card('research'));
  fireEvent.wheel(graph, { deltaY: -550, clientX: 30, clientY: 30 });
  const zoomed = transform();
  await user.click(switchView());
  await user.click(switchView());
  expect(transform()).toBe(zoomed);
  await user.click(switchView());
  expect(graph.clientWidth).toBe(0);
  act(() => nav.current?.showNode('approval'));
  expect(transform()).toBe(zoomed);
  await user.click(switchView());
  expect(card('approval')).toHaveAttribute('aria-pressed', 'true');
  expect(transform().split('scale')[1]).toBe(zoomed.split('scale')[1]);
  expect(transform()).not.toBe(zoomed);
});

it('opens a problem inside a folded box in place, and switches to the graph for its wire', async () => {
  const draft = research();
  const edge = required(draft.definition.controlEdges.find((e) => e.source === 'write'));
  const { nav, user, editor } = mount(draft, false, [
    { code: 'DEAD_END', severity: 'error', nodeId: 'write', message: 'No next step' },
    { code: 'INVALID_PORT', severity: 'error', edgeId: edge.id, message: 'Broken wire' },
  ]);
  await user.click(screen.getByRole('button', { name: /^Collapse / }));
  expect(findRow('write')).toBeNull();
  act(() => nav.current?.showProblems());
  await user.click(within(sheet()).getByRole('button', { name: /This step has no next step/ }));
  expect(row('write')).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByRole('application', { name: messages.TeamEditor.canvas })).toBeNull();
  act(() => nav.current?.showProblems());
  await user.click(within(sheet()).getByRole('button', { name: /uses a port/ }));
  expect(screen.getByRole('application', { name: messages.TeamEditor.canvas })).toBeVisible();
  expect(
    within(sheet()).getByRole('heading', { name: messages.TeamEditor.connection }),
  ).toBeInTheDocument();
  expect(editor.getState().draft).toBe(draft);
  expect(editor.getState().past).toEqual([]);
});

it('opens the requested node, rather than the previous list stop, after an external navigation', async () => {
  const { nav, user } = mount(research(), true);
  await user.click(row('research'));
  await user.keyboard('{Escape}');
  act(() => nav.current?.showNode('write'));
  await user.keyboard('{Escape}');
  expect(row('write')).toHaveFocus();
});

it('keeps a manually panned graph after a hidden edit that does not move any step', async () => {
  const { user, editor } = mount();
  await user.click(switchView());
  const graph = screen.getByRole('application', { name: messages.TeamEditor.canvas });
  const stage = required(graph.querySelector<HTMLElement>('[data-graph-stage]'));
  await user.click(card('research'));
  fireEvent.wheel(graph, { deltaY: -1200, clientX: 1200, clientY: 800 });
  const panned = stage.style.transform;
  await user.click(switchView());
  act(() => {
    editor
      .getState()
      .applyDraft(patchNode(editor.getState().draft, 'research', { label: 'Research notes' }));
  });
  await user.click(switchView());
  expect(stage.style.transform).toBe(panned);
});

it('opens the graph at the fan-out node, not the first parallel branch', async () => {
  const d = teamTemplate('parallel-review', 'audit', {
    name: 'Audit',
    brief: 'Review the change',
    criteria: [],
    roles: {
      scope: { name: 'Scope', duty: 'Scope the change' },
      correctness: { name: 'Correctness', duty: 'Check correctness' },
      security: { name: 'Security', duty: 'Check security' },
      synthesis: { name: 'Synthesis', duty: 'Synthesize the reviews' },
    },
    labels: { loop: 'Loop', decision: 'Decision', join: 'Gather', output: 'Output' },
  });
  const { user, editor } = mount(draftFromDefinition(d));
  const group = screen.getByRole('list', { name: 'In parallel' });
  await user.click(
    within(required(group.parentElement)).getByRole('button', { name: 'Show in flow graph' }),
  );
  expect(screen.getByRole('application', { name: messages.TeamEditor.canvas })).toBeVisible();
  expect(card('scope')).toHaveAttribute('aria-pressed', 'true');
  expect(card('correctness')).toHaveAttribute('aria-pressed', 'false');
  expect(editor.getState().past).toHaveLength(0);
});
