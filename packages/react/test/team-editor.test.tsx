import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StudioStoresProvider } from '../src/context.tsx';
import { type EditorDraft, emptyDraft } from '../src/editor/model.ts';
import { createEditorStore } from '../src/editor/store.ts';
import messages from '../src/messages/en.json' with { type: 'json' };
import { sessionStore } from '../src/stories/fixtures.tsx';
import {
  applyPattern,
  type EditResult,
  patchNode,
  placeStep,
} from '../src/team-editor/commands.ts';
import { TeamEditor } from '../src/team-editor/TeamEditor.tsx';

// The team editor's own behaviour (docs/specs/features/canvas.md), through its controls.

beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
});
afterAll(() => vi.restoreAllMocks());

function ok(result: EditResult): { draft: EditorDraft; nodeId: string } {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return { draft: result.draft, nodeId: result.nodeId ?? '' };
}
function chain(length: number): EditorDraft {
  let { draft, nodeId } = ok(placeStep(emptyDraft(), 'agent', { kind: 'empty' }));
  for (let i = 1; i < length; i++)
    ({ draft, nodeId } = ok(placeStep(draft, 'agent', { kind: 'after', nodeId })));
  return draft;
}
function renderEditor(draft: EditorDraft) {
  const editor = createEditorStore(draft);
  render(
    <IntlProvider locale="en" messages={messages}>
      <StudioStoresProvider editor={editor} session={sessionStore()}>
        <TeamEditor editor={editor} />
      </StudioStoresProvider>
    </IntlProvider>,
  );
  return editor;
}
const canvasNode = (id: string) =>
  document.querySelector(`[data-team-canvas] [data-node="${id}"]`) as HTMLElement;
const choose = async (combobox: string | RegExp, option: string | RegExp) => {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name: combobox }));
  // The list renders a moment after the click under load.
  await user.click(await screen.findByRole('option', { name: option }));
};

describe('team editor', () => {
  it('puts the add button on the team row of the outline, with no heading over the outline', () => {
    renderEditor(chain(1));
    const outline = screen.getByRole('complementary', { name: messages.TeamEditor.outline });
    expect(outline.querySelector('h2')).toBeNull();
    expect(outline.textContent).not.toContain('Structure');
    const add = screen.getByRole('button', { name: messages.TeamEditor.addStep });
    const problems = screen.getByRole('button', { name: /problems?$/ });
    // The team row holds the team name, its problems and the add button.
    expect(add.parentElement).toBe(problems.parentElement);
  });

  it('names the reviewer in the canvas mark of a missing-criteria warning', () => {
    const { draft } = ok(applyPattern(chain(1), 'reviewLoop', ['agent_1']));
    const contracts = new Map(draft.definition.roles.map((r) => [r.id, r.outputContract]));
    const reviewer = draft.definition.nodes.find(
      (n) => n.type === 'agent' && contracts.get(n.roleId) === 'review',
    );
    if (reviewer?.type !== 'agent') throw new Error('the pattern made no reviewer');
    renderEditor(
      patchNode(draft, reviewer.id, {
        inputBindings: reviewer.inputBindings.filter((b) => b.kind !== 'run_input'),
      }),
    );
    const mark = canvasNode(reviewer.id).querySelector('[data-problem]');
    expect(mark?.getAttribute('title')).toContain(
      `${reviewer.label} does not get the criteria, so its review cannot check them.`,
    );
  });

  it('lists the problems and brings the chosen one into view', async () => {
    // A rule reads the agent's output, so what is left is its unconnected branches.
    const review = ok(placeStep(chain(1), 'rule', { kind: 'after', nodeId: 'agent_1' }));
    renderEditor(review.draft);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /problems?$/ })));
    const item = screen
      .getAllByRole('button', { name: /A branch of this decision is not connected/ })
      .at(0) as HTMLElement;
    await act(async () => fireEvent.click(item));
    expect(canvasNode(review.nodeId).getAttribute('aria-pressed')).toBe('true');
  });

  it('offers only agents in the flow as input sources', async () => {
    const draft = patchNode(chain(3), 'agent_2', { invocation: 'callable' });
    renderEditor(draft);
    await act(async () => fireEvent.click(canvasNode('agent_3')));
    await act(async () => fireEvent.click(screen.getByRole('combobox', { name: 'From' })));
    const sources = screen.getAllByRole('option').map((o) => o.textContent);
    expect(sources).toContain('Agent 1');
    expect(sources).not.toContain('Agent 2');
  });

  it('keeps drawing when an undo removes a box that is still animating in', async () => {
    const editor = renderEditor(chain(1));
    const team = ok(placeStep(chain(1), 'team', { kind: 'after', nodeId: 'agent_1' }));
    await act(async () => editor.getState().applyDraft(team.draft));
    await act(async () => editor.getState().undo());
    expect(canvasNode('agent_1')).toBeTruthy();
    expect(canvasNode(team.nodeId)).toBeNull();
  });

  it('offers a referenced Team as an input source and takes inputs on it', async () => {
    const draft = chain(2);
    draft.definition.nodes.push({
      id: 'saved_team',
      type: 'team',
      label: 'Saved team',
      source: { kind: 'reference', corralId: 'y', definitionRevision: 1 },
    });
    const editor = renderEditor(draft);
    await act(async () => fireEvent.click(canvasNode('agent_2')));
    await act(async () => fireEvent.click(screen.getByRole('combobox', { name: 'From' })));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain('Saved team');
    await act(async () =>
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }),
    );
    await act(async () => fireEvent.click(canvasNode('saved_team')));
    expect(screen.getByRole('group', { name: 'Inputs' })).toBeTruthy();
    await choose('From', 'Agent 2');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add' })));
    expect(
      editor.getState().draft.definition.nodes.find((n) => n.id === 'saved_team'),
    ).toMatchObject({ inputBindings: [{ kind: 'task_output', sourceNodeId: 'agent_2' }] });
  });

  it('adds a specific-version input only with the version it names', async () => {
    const editor = renderEditor(chain(1));
    await act(async () => fireEvent.click(canvasNode('agent_1')));
    await choose('Kind', 'Specific version');
    const add = screen.getByRole('button', { name: 'Add' });
    expect(add.hasAttribute('disabled') || add.getAttribute('aria-disabled') === 'true').toBe(true);
    await act(async () =>
      fireEvent.change(screen.getByRole('textbox', { name: 'Result version' }), {
        target: { value: 'av_draft_2' },
      }),
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add' })));
    const node = editor.getState().draft.definition.nodes.find((n) => n.id === 'agent_1');
    expect(node?.type === 'agent' && node.inputBindings.at(-1)).toMatchObject({
      kind: 'explicit_version',
      artifactVersionId: 'av_draft_2',
    });
  });

  it('connects two steps without a pointer drag', async () => {
    const draft = ok(placeStep(chain(1), 'agent', { kind: 'empty' })).draft;
    const editor = renderEditor(draft);
    await act(async () => fireEvent.click(canvasNode('agent_1')));
    await choose('Connect out to…', 'Agent 2');
    expect(editor.getState().draft.definition.controlEdges).toEqual([
      expect.objectContaining({ source: 'agent_1', sourcePort: 'out', target: 'agent_2' }),
    ]);
  });

  it('applies a review loop to the selection from the command menu', async () => {
    const editor = renderEditor(chain(2));
    await act(async () => fireEvent.click(canvasNode('agent_1')));
    await act(async () => fireEvent.keyDown(canvasNode('agent_1'), { key: 'k', ctrlKey: true }));
    await act(async () =>
      fireEvent.click(screen.getByRole('option', { name: /Wrap in a review loop/ })),
    );
    const { nodes } = editor.getState().draft.definition;
    const loop = nodes.find((n) => n.type === 'loop');
    expect(nodes.find((n) => n.id === 'agent_1')?.parentId).toBe(loop?.id);
    expect(nodes.some((n) => n.type === 'decision' && n.mode === 'review')).toBe(true);
    expect(nodes.some((n) => n.type === 'decision' && n.mode === 'approval')).toBe(false);
  });
});
