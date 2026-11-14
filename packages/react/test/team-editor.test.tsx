import { type AgentRole, CorralDefinition } from '@corral/contracts';
import { definitionHash } from '@corral/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StudioStoresProvider } from '../src/context.tsx';
import {
  type EditorDraft,
  emptyDraft,
  exportDefinition,
  importDefinition,
  updateNode,
} from '../src/editor/model.ts';
import { createEditorStore } from '../src/editor/store.ts';
import messages from '../src/messages/en.json' with { type: 'json' };
import koMessages from '../src/messages/ko.json' with { type: 'json' };
import { sessionStore } from '../src/stories/fixtures.tsx';
import {
  applyPattern,
  type EditResult,
  patchNode,
  placeStep,
  type TeamReference,
  watchAgent,
  wrapIn,
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
function renderEditor(
  draft: EditorDraft,
  profiles?: { profileId: string; label: string; available: boolean }[],
  imageProfiles?: { profileId: string; label: string }[] | null,
) {
  const editor = createEditorStore(draft);
  render(
    <IntlProvider locale="en" messages={messages}>
      <StudioStoresProvider editor={editor} session={sessionStore()}>
        <TeamEditor
          editor={editor}
          {...(profiles ? { profiles } : {})}
          {...(imageProfiles !== undefined ? { imageProfiles } : {})}
        />
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
    if (reviewer?.type !== 'agent' || reviewer.invocation === 'observer')
      throw new Error('the pattern made no reviewer');
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

  it('reports a role whose model profile is not installed only while some profile is', () => {
    // An agent wired to an output has no other problem; its role names the default profile.
    const team = ok(placeStep(chain(1), 'output', { kind: 'after', nodeId: 'agent_1' })).draft;
    const profile = team.definition.roles[0]?.modelProfile ?? '';
    const problems = () => screen.getByRole('button', { name: /problems?$/ }).textContent;
    // With no profile installed there is nothing to compare with, and the model is missing for
    // every team alike: the team is not the place that says so.
    renderEditor(team, []);
    expect(problems()).toBe('No problems');
    cleanup();
    renderEditor(team, [{ profileId: profile, label: 'Installed', available: true }]);
    expect(problems()).toBe('No problems');
    cleanup();
    renderEditor(team, [{ profileId: `${profile}-other`, label: 'Another', available: true }]);
    expect(problems()).toBe('1 problem');
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

  it.each([
    [{ maxIterations: undefined }, messages.Validation.codes.LOOP_MAX_ITERATIONS],
    [
      { limitPolicy: { kind: 'raise_reasoning', level: 'off' } },
      messages.Validation.codes.LOOP_REASONING_OFF,
    ],
  ])('names a Loop limit problem in its own words (%o)', async (change, words) => {
    const wrapped = ok(wrapIn(chain(2), ['agent_1'], 'loop'));
    renderEditor(patchNode(wrapped.draft, wrapped.nodeId, change));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /problems?$/ })));
    const named = screen.getAllByRole('button').filter((b) => b.textContent?.includes(words));
    expect(named.length).toBeGreaterThan(0);
  });

  it('has no problems after a check loop wraps the step before a parallel split', () => {
    const chained = ok(placeStep(chain(4), 'output', { kind: 'after', nodeId: 'agent_4' })).draft;
    const split = ok(applyPattern(chained, 'parallel', ['agent_3'])).draft;
    renderEditor(ok(applyPattern(split, 'checkLoop', ['agent_2'])).draft);
    expect(screen.getByRole('button', { name: /problems?$/ }).textContent).toBe('No problems');
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
    expect(
      node?.type === 'agent' && node.invocation !== 'observer' && node.inputBindings.at(-1),
    ).toMatchObject({
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

  it('chooses a saved image profile instead of typing its id', async () => {
    const editor = renderEditor(chain(1), undefined, [
      { profileId: 'illustration', label: 'illustration · gpt-image-1' },
      { profileId: 'keyed:gpt-image-1', label: 'keyed:gpt-image-1 · gpt-image-1' },
    ]);
    await act(async () => fireEvent.click(canvasNode('agent_1')));
    expect(screen.queryByRole('textbox', { name: /Image profile/ })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('switch', { name: 'Generate images' })));
    expect(screen.queryByRole('textbox', { name: /Image profile/ })).toBeNull();
    await choose('Image profile', 'illustration · gpt-image-1');
    expect(editor.getState().draft.definition.roles[0]?.imageProfile).toBe('illustration');
  });

  it('keeps a role image profile id that is not in the saved list', async () => {
    const draft = updateNode(chain(1), 'agent_1', {
      generateImage: true,
      imageProfile: 'legacy_hand',
    });
    const editor = renderEditor(draft, undefined, [
      { profileId: 'illustration', label: 'illustration · gpt-image-1' },
    ]);
    await act(async () => fireEvent.click(canvasNode('agent_1')));
    expect(screen.queryByRole('textbox', { name: /Image profile/ })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Image profile' }).textContent).toContain(
      `legacy_hand (${messages.Inspector.imageProfileMissing})`,
    );
    expect(editor.getState().draft.definition.roles[0]?.imageProfile).toBe('legacy_hand');
  });

  it('applies a review loop to the selection from the command menu', async () => {
    const editor = renderEditor(chain(2));
    await act(async () => fireEvent.click(canvasNode('agent_1')));
    await act(async () => fireEvent.keyDown(canvasNode('agent_1'), { key: 'k', ctrlKey: true }));
    await act(async () =>
      fireEvent.click(screen.getByRole('option', { name: /Wrap in a review Loop/ })),
    );
    const { nodes } = editor.getState().draft.definition;
    const loop = nodes.find((n) => n.type === 'loop');
    expect(nodes.find((n) => n.id === 'agent_1')?.parentId).toBe(loop?.id);
    expect(nodes.some((n) => n.type === 'decision' && n.mode === 'review')).toBe(true);
    expect(nodes.some((n) => n.type === 'decision' && n.mode === 'approval')).toBe(false);
  });
});

// Advisors in the editor (docs/specs/features/canvas.md rules 3, 4, 5 and 11).
describe('team editor: advisors', () => {
  const advisorIn = (draft: EditorDraft) =>
    draft.definition.nodes.find((n) => n.type === 'agent' && n.invocation === 'observer');
  const watchedBy = (draft: EditorDraft, advisor: string) =>
    draft.definition.capabilityLinks
      .filter((l) => l.kind === 'advise' && l.sourceNodeId === advisor)
      .map((l) => l.targetNodeId)
      .sort();
  const addAdvisor = () =>
    act(async () =>
      fireEvent.click(
        within(screen.getByRole('toolbar', { name: messages.TeamEditor.palette })).getByRole(
          'button',
          { name: `Add ${messages.TeamEditor.kinds.observer}` },
        ),
      ),
    );

  it('watches A from above the flow, adds B in its sheet, and keeps out of a Loop (canvas.feature)', async () => {
    const draft = chain(2);
    const editor = renderEditor(draft);
    await act(async () => fireEvent.click(canvasNode('agent_1')));
    await addAdvisor();
    const advisor = advisorIn(editor.getState().draft);
    if (!advisor) throw new Error('no advisor was added');
    expect(watchedBy(editor.getState().draft, advisor.id)).toEqual(['agent_1']);
    // No control ports, and the run order is what it was.
    expect(document.querySelector(`[data-port^="${advisor.id}:"]`)).toBeNull();
    expect(editor.getState().draft.definition.controlEdges).toEqual(draft.definition.controlEdges);
    const top = (id: string) =>
      Number(/translate\([^,]+,\s*(-?[\d.]+)px\)/.exec(canvasNode(id).style.transform)?.[1]);
    expect(top(advisor.id)).toBeLessThan(top('agent_1'));
    await choose(messages.Inspector.addWatched, 'Agent 2');
    expect(watchedBy(editor.getState().draft, advisor.id)).toEqual(['agent_1', 'agent_2']);
    // Drawn dash-dot: neither the solid control line nor the dashed call link.
    const drawn = [...document.querySelectorAll('[data-team-canvas] [data-edge^="link_"]')].map(
      (g) => g.querySelectorAll('path')[1]?.getAttribute('stroke-dasharray'),
    );
    expect(drawn).toHaveLength(2);
    for (const dashes of drawn) expect(dashes?.split(' ').length).toBe(4);
    const control = document.querySelector('[data-team-canvas] [data-edge^="edge_"]');
    expect(control?.querySelectorAll('path')[1]?.getAttribute('stroke-dasharray')).toBeNull();
    await act(async () => fireEvent.click(canvasNode('agent_1'), { shiftKey: true }));
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: messages.TeamEditor.wrapLoop })),
    );
    const { nodes } = editor.getState().draft.definition;
    const loop = nodes.find((n) => n.type === 'loop');
    expect(nodes.find((n) => n.id === 'agent_1')?.parentId).toBe(loop?.id);
    expect(nodes.find((n) => n.id === advisor.id)?.parentId).toBeUndefined();
  });

  it('saves and reopens an advisor the schema accepts with the same hash', async () => {
    const editor = renderEditor(chain(2));
    await act(async () => fireEvent.click(canvasNode('agent_2')));
    await addAdvisor();
    const saved = exportDefinition(editor.getState().draft);
    const parsed = CorralDefinition.safeParse(JSON.parse(saved));
    expect(parsed.success).toBe(true);
    const reopened = importDefinition(saved);
    if (!reopened.ok) throw new Error(reopened.errors.join('\n'));
    expect(definitionHash(reopened.draft.definition)).toBe(
      definitionHash(editor.getState().draft.definition),
    );
    cleanup();
    renderEditor(reopened.draft);
    const advisor = advisorIn(reopened.draft);
    expect(canvasNode(advisor?.id ?? '')).toBeTruthy();
    // The line carries no name: it is the only link of its kind.
    expect(screen.queryAllByText(messages.TeamEditor.links.advise)).toEqual([]);
    expect(document.querySelector('[data-edge="link_1"] title')?.textContent).toBe(
      'Advisor watches Agent 2',
    );
  });

  it('shows what is wrong with an advisor on its card, in its sheet and in the outline', async () => {
    const { draft, nodeId } = ok(placeStep(chain(2), 'observer', { kind: 'empty' }));
    renderEditor(draft);
    const text = messages.Validation.codes.ADVISOR_UNWATCHED.replace('{node}', 'Advisor');
    expect(canvasNode(nodeId).querySelector('[data-problem]')?.getAttribute('title')).toContain(
      text,
    );
    const outline = screen.getByRole('complementary', { name: messages.TeamEditor.outline });
    expect(
      within(outline)
        .getByRole('button', { name: /^Advisor/ })
        .querySelector('.text-destructive, .text-warning'),
    ).toBeTruthy();
    // Listed, but after the flow: it is not a step of it.
    const rows = within(outline)
      .getAllByRole('button', { pressed: false })
      .map((b) => b.textContent);
    expect(
      rows.filter((r) => r === 'Agent 1' || r === 'Agent 2' || r?.startsWith('Advisor')),
    ).toEqual(['Agent 1', 'Agent 2', expect.stringMatching(/^Advisor/)]);
    await act(async () => fireEvent.click(canvasNode(nodeId)));
    const sheet = screen.getByRole('complementary', { name: messages.TeamEditor.inspector });
    expect(
      within(sheet).getByRole('region', { name: messages.TeamEditor.issues }).textContent,
    ).toContain(text);
  });

  it('settles the advisor sheet: reads, watches and a review interval, but no inputs, output, calls or retry', async () => {
    const { draft, nodeId } = ok(
      placeStep(chain(1), 'observer', { kind: 'after', nodeId: 'agent_1' }),
    );
    const editor = renderEditor(
      patchNode(draft, nodeId, { review: { interval: 3, maxRequestsPerReview: 12 } }),
    );
    await act(async () => fireEvent.click(canvasNode(nodeId)));
    const sheet = screen.getByRole('complementary', { name: messages.TeamEditor.inspector });
    const inSheet = within(sheet);
    expect(inSheet.queryByRole('group', { name: messages.Inspector.inputs })).toBeNull();
    expect(inSheet.queryByRole('group', { name: messages.Inspector.calls })).toBeNull();
    expect(inSheet.queryByText(messages.Inspector.contract)).toBeNull();
    expect(inSheet.queryByText(messages.Inspector.advanced)).toBeNull();
    expect(inSheet.queryByText(messages.TeamEditor.fields.retry)).toBeNull();
    expect(inSheet.queryByRole('switch', { name: messages.Inspector.fileTools })).toBeNull();
    expect(inSheet.getByRole('radio', { name: messages.Inspector.observer })).toBeTruthy();
    for (const tool of Object.values(messages.Inspector.readTool))
      expect(inSheet.getByRole('checkbox', { name: tool })).toBeTruthy();
    expect(inSheet.getByRole('button', { name: 'Stop watching Agent 1' })).toBeTruthy();
    await act(async () =>
      fireEvent.change(inSheet.getByRole('spinbutton', { name: messages.Inspector.reviewField }), {
        target: { value: '5' },
      }),
    );
    const advisor = editor.getState().draft.definition.nodes.find((n) => n.id === nodeId);
    expect(advisor).toMatchObject({ review: { interval: 5, maxRequestsPerReview: 12 } });
    await act(async () =>
      fireEvent.click(inSheet.getByRole('checkbox', { name: messages.Inspector.readTool.search })),
    );
    const role = editor
      .getState()
      .draft.definition.roles.find((r) => advisor?.type === 'agent' && r.id === advisor.roleId);
    expect(role?.allowedWorkTools).not.toContain('search');
    await act(async () =>
      fireEvent.click(inSheet.getByRole('button', { name: 'Stop watching Agent 1' })),
    );
    expect(editor.getState().draft.definition.capabilityLinks).toEqual([]);
  });

  it('names the advisor card with its kind and draws its links behind the cards', () => {
    const added = ok(placeStep(chain(2), 'observer', { kind: 'after', nodeId: 'agent_2' }));
    renderEditor(patchNode(added.draft, added.nodeId, { label: 'Fact checker' }));
    const card = canvasNode(added.nodeId);
    // Its kind is said on its own, not only inside the prompt or a problem.
    expect(within(card).getByText(messages.TeamEditor.kinds.observer)).toBeTruthy();
    const lines = document.querySelector('[data-team-canvas] svg') as Element;
    // Later siblings paint over earlier ones: the lines come before every card.
    for (const id of [added.nodeId, 'agent_1', 'agent_2'])
      expect(lines.compareDocumentPosition(canvasNode(id)) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
  });

  it('shows no Start on an advisor even when a draft names it the start', () => {
    const added = ok(placeStep(chain(2), 'observer', { kind: 'after', nodeId: 'agent_1' }));
    renderEditor({
      ...added.draft,
      definition: { ...added.draft.definition, entryNodeId: added.nodeId },
    });
    expect(canvasNode(added.nodeId).textContent).not.toContain(messages.TeamEditor.start);
  });

  it('moves focus to the next chip, then to the add list, as watched agents are removed', async () => {
    let { draft, nodeId } = ok(
      placeStep(chain(3), 'observer', { kind: 'after', nodeId: 'agent_1' }),
    );
    for (const agent of ['agent_2', 'agent_3']) {
      const linked = watchAgent(draft, nodeId, agent);
      if (!linked.ok) throw new Error(linked.reason);
      draft = linked.draft;
    }
    renderEditor(draft);
    await act(async () => fireEvent.click(canvasNode(nodeId)));
    const chip = (name: string) => screen.getByRole('button', { name: `Stop watching ${name}` });
    chip('Agent 2').focus();
    await act(async () => fireEvent.click(chip('Agent 2')));
    expect(document.activeElement).toBe(chip('Agent 3'));
    const add = () => screen.getByRole('combobox', { name: messages.Inspector.addWatched });
    await act(async () => fireEvent.click(chip('Agent 3')));
    expect(document.activeElement).toBe(add());
    chip('Agent 1').focus();
    await act(async () => fireEvent.click(chip('Agent 1')));
    expect(document.activeElement).toBe(add());
  });

  it('keeps the review interval a whole number of at least one', async () => {
    const { draft, nodeId } = ok(
      placeStep(chain(2), 'observer', { kind: 'after', nodeId: 'agent_1' }),
    );
    const editor = renderEditor(draft);
    await act(async () => fireEvent.click(canvasNode(nodeId)));
    const field = screen.getByRole('spinbutton', { name: messages.Inspector.reviewField });
    for (const value of ['0', '-2', '1.5']) {
      await act(async () => fireEvent.change(field, { target: { value } }));
      expect(
        editor.getState().draft.definition.nodes.find((n) => n.id === nodeId),
      ).not.toHaveProperty('review');
    }
  });

  it('lists only agents in the flow and callable agents to watch', async () => {
    let draft = ok(placeStep(chain(2), 'agent', { kind: 'empty' })).draft;
    draft = patchNode(draft, 'agent_3', { invocation: 'callable', label: 'Helper' });
    draft = ok(placeStep(draft, 'output', { kind: 'after', nodeId: 'agent_2' })).draft;
    draft = ok(placeStep(draft, 'review', { kind: 'after', nodeId: 'agent_1' })).draft;
    draft = ok(placeStep(draft, 'observer', { kind: 'empty' })).draft;
    const { draft: withAdvisor, nodeId } = ok(placeStep(draft, 'observer', { kind: 'empty' }));
    renderEditor(withAdvisor);
    await act(async () => fireEvent.click(canvasNode(nodeId)));
    await act(async () =>
      fireEvent.click(screen.getByRole('combobox', { name: messages.Inspector.addWatched })),
    );
    expect(
      screen
        .getAllByRole('option')
        .map((o) => o.textContent)
        .sort(),
    ).toEqual(['Agent 1', 'Agent 2', 'Helper'].sort());
  });

  it('shows no work style settings and no role import on an advisor sheet', async () => {
    const added = ok(placeStep(chain(2), 'observer', { kind: 'after', nodeId: 'agent_1' }));
    const editor = createEditorStore(added.draft);
    render(
      <IntlProvider locale="en" messages={messages}>
        <StudioStoresProvider editor={editor} session={sessionStore()}>
          <TeamEditor editor={editor} roleSettings={() => <p>Work style here</p>} />
        </StudioStoresProvider>
      </IntlProvider>,
    );
    await act(async () => fireEvent.click(canvasNode('agent_1')));
    expect(screen.getByText('Work style here')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import role…' })).toBeTruthy();
    await act(async () => fireEvent.click(canvasNode(added.nodeId)));
    expect(screen.queryByText('Work style here')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import role…' })).toBeNull();
  });

  it('adds an advisor from ⌘K watching a selected callable agent, not in the flow’s place', async () => {
    const draft = patchNode(ok(placeStep(chain(2), 'agent', { kind: 'empty' })).draft, 'agent_3', {
      invocation: 'callable',
    });
    const editor = renderEditor(draft);
    await act(async () => fireEvent.click(canvasNode('agent_3')));
    await act(async () => fireEvent.keyDown(canvasNode('agent_3'), { key: 'k', ctrlKey: true }));
    const option = screen.getByRole('option', { name: /Add Advisor/ });
    expect(option.textContent).toContain('watching Agent 3');
    await act(async () => fireEvent.click(option));
    const advisor = advisorIn(editor.getState().draft);
    expect(watchedBy(editor.getState().draft, advisor?.id ?? '')).toEqual(['agent_3']);
  });

  it('turns an agent into an advisor from its sheet', async () => {
    const editor = renderEditor(chain(2));
    await act(async () => fireEvent.click(canvasNode('agent_2')));
    await act(async () =>
      fireEvent.click(screen.getByRole('radio', { name: messages.Inspector.observer })),
    );
    const node = editor.getState().draft.definition.nodes.find((n) => n.id === 'agent_2');
    expect(node).toMatchObject({ invocation: 'observer' });
    expect(editor.getState().draft.definition.controlEdges).toEqual([]);
    expect(screen.queryByRole('group', { name: messages.Inspector.inputs })).toBeNull();
  });
});

describe('team editor: importing a role', () => {
  const releaseCheck: AgentRole = {
    id: 'release',
    name: 'Release check',
    prompt: 'Check the release notes against the change.',
    modelProfile: 'model-b',
    allowedWorkTools: ['write_artifact', 'read_file'],
    allowedCollaborationTools: ['read_artifact', 'submit_result'],
    outputContract: 'review',
    harness: { profileId: 'careful', revision: 2 },
  };
  const otherTeams: TeamReference[] = [
    { corralId: 'harbor', definitionRevision: 3, name: 'Harbor', roles: [releaseCheck] },
  ];
  const presetNames = [
    'Implementation',
    'Plan',
    'Review',
    'Cause investigation',
    'Correctness review',
    'Security review',
    'Research',
    'Writing',
  ];

  function renderWith(
    draft: EditorDraft,
    options: { locale?: 'en' | 'ko'; teams?: TeamReference[] } = {},
  ) {
    const editor = createEditorStore(draft);
    const locale = options.locale ?? 'en';
    const view = render(
      <IntlProvider locale={locale} messages={locale === 'ko' ? koMessages : messages}>
        <StudioStoresProvider editor={editor} session={sessionStore()}>
          <TeamEditor editor={editor} teams={options.teams ?? otherTeams} />
        </StudioStoresProvider>
      </IntlProvider>,
    );
    return { editor, view };
  }
  const roleOf = (draft: EditorDraft, nodeId: string) => {
    const node = draft.definition.nodes.find((n) => n.id === nodeId);
    return draft.definition.roles.find((r) => node?.type === 'agent' && r.id === node.roleId);
  };

  it('is a command in ⌘K and an action in the agent sheet', async () => {
    renderWith(chain(2));
    await act(async () => fireEvent.click(canvasNode('agent_1')));
    const sheet = screen.getByRole('complementary', { name: 'Settings' });
    expect(within(sheet).getByRole('button', { name: 'Import role…' })).toBeTruthy();
    await act(async () => fireEvent.keyDown(canvasNode('agent_1'), { key: 'k', ctrlKey: true }));
    expect(screen.getByRole('option', { name: /Import role…/ })).toBeTruthy();
  });

  it('lists the presets first, then the roles of the other saved teams', async () => {
    renderWith(chain(1));
    await act(async () => fireEvent.click(canvasNode('agent_1')));
    const sheet = screen.getByRole('complementary', { name: 'Settings' });
    await act(async () =>
      fireEvent.click(within(sheet).getByRole('button', { name: 'Import role…' })),
    );
    const groups = screen.getAllByRole('group').map((group) => ({
      heading: group.getAttribute('aria-labelledby')
        ? document.getElementById(group.getAttribute('aria-labelledby') as string)?.textContent
        : null,
      options: within(group)
        .getAllByRole('option')
        .map((o) => o.textContent),
    }));
    expect(groups.map((g) => g.heading)).toEqual(['Role presets', 'Harbor']);
    expect(groups[0]?.options.map((o) => presetNames.find((name) => o?.startsWith(name)))).toEqual(
      presetNames,
    );
    expect(groups[1]?.options).toEqual(['Release check']);
  });

  it('copies the chosen role onto the selected agent from the sheet', async () => {
    const draft = chain(2);
    const { editor } = renderWith(draft);
    await act(async () => fireEvent.click(canvasNode('agent_1')));
    const sheet = screen.getByRole('complementary', { name: 'Settings' });
    await act(async () =>
      fireEvent.click(within(sheet).getByRole('button', { name: 'Import role…' })),
    );
    await act(async () => fireEvent.click(screen.getByRole('option', { name: 'Release check' })));
    const next = editor.getState().draft;
    expect(roleOf(next, 'agent_1')).toMatchObject({
      prompt: releaseCheck.prompt,
      outputContract: 'review',
      modelProfile: 'model-b',
    });
    expect(next.definition.nodes.find((n) => n.id === 'agent_1')?.label).toBe('Agent 1');
    expect(roleOf(next, 'agent_2')).toEqual(roleOf(draft, 'agent_2'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => editor.getState().undo());
    expect(editor.getState().draft).toBe(draft);
  });

  it('works from the keyboard alone and gives focus back to the editor', async () => {
    const { editor, view } = renderWith(chain(1));
    const user = userEvent.setup();
    await act(async () => canvasNode('agent_1').focus());
    await user.keyboard('{Enter}');
    expect(canvasNode('agent_1').getAttribute('aria-pressed')).toBe('true');
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('import');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('option', { name: 'Release check' })).toBeTruthy();
    await user.keyboard('rel');
    await user.keyboard('{Enter}');
    expect(roleOf(editor.getState().draft, 'agent_1')?.prompt).toBe(releaseCheck.prompt);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(view.container.contains(document.activeElement)).toBe(true);
  });

  it('adds an agent named after the role when nothing is selected', async () => {
    const { editor } = renderWith(chain(1));
    await act(async () =>
      fireEvent.keyDown(document.querySelector('[data-team-canvas]') as HTMLElement, {
        key: 'k',
        ctrlKey: true,
      }),
    );
    await act(async () => fireEvent.click(screen.getByRole('option', { name: /Import role…/ })));
    await act(async () => fireEvent.click(screen.getByRole('option', { name: 'Plan' })));
    const added = editor
      .getState()
      .draft.definition.nodes.find((n) => n.type === 'agent' && n.id !== 'agent_1');
    expect(added?.label).toBe('Plan');
    expect(canvasNode(added?.id as string).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the presets in Korean on the Korean screen', async () => {
    renderWith(chain(1), { locale: 'ko' });
    await act(async () => fireEvent.click(canvasNode('agent_1')));
    const sheet = screen.getByRole('complementary', { name: '설정' });
    await act(async () =>
      fireEvent.click(within(sheet).getByRole('button', { name: '역할 가져오기…' })),
    );
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    for (const name of [
      '구현',
      '계획',
      '검토',
      '원인 조사',
      '정확성 검토',
      '보안 검토',
      '조사',
      '작성',
    ])
      expect(options).toContain(name);
    expect(options).not.toContain('Implementation');
  });

  it('says once that a work style it could not resolve was left out', async () => {
    const { editor } = renderWith(chain(2));
    await act(async () => fireEvent.click(canvasNode('agent_1')));
    const sheet = screen.getByRole('complementary', { name: 'Settings' });
    await act(async () =>
      fireEvent.click(within(sheet).getByRole('button', { name: 'Import role…' })),
    );
    await act(async () => fireEvent.click(screen.getByRole('option', { name: 'Release check' })));
    expect(roleOf(editor.getState().draft, 'agent_1')).not.toHaveProperty('harness');
    const notices = screen
      .getAllByRole('status')
      .filter((s) => s.textContent?.includes('without its Harness'));
    expect(notices).toHaveLength(1);
    // The agent's sheet shows it under its heading.
    expect(
      within(screen.getByRole('complementary', { name: 'Settings' })).getAllByText(
        /without its Harness/,
      ),
    ).toHaveLength(1);
    // The next edit takes the notice away; it does not come back with redo.
    await act(async () => editor.getState().undo());
    expect(screen.queryAllByText(/without its Harness/)).toEqual([]);
    await act(async () => editor.getState().redo());
    expect(roleOf(editor.getState().draft, 'agent_1')?.prompt).toBe(releaseCheck.prompt);
    expect(screen.queryAllByText(/without its Harness/)).toEqual([]);
  });

  it('says nothing when the role had no work style', async () => {
    renderWith(chain(1));
    await act(async () => fireEvent.click(canvasNode('agent_1')));
    const sheet = screen.getByRole('complementary', { name: 'Settings' });
    await act(async () =>
      fireEvent.click(within(sheet).getByRole('button', { name: 'Import role…' })),
    );
    await act(async () => fireEvent.click(screen.getByRole('option', { name: /^Plan/ })));
    expect(screen.queryAllByText(/without its Harness/)).toEqual([]);
  });
});
