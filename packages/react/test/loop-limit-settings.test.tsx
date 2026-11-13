import type { LoopNode } from '@corral/contracts';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { useStore } from 'zustand';
import { compileDraft, type EditorDraft, emptyDraft } from '../src/editor/model.ts';
import { createEditorStore, type EditorStore } from '../src/editor/store.ts';
import messages from '../src/messages/en.json' with { type: 'json' };
import { type EditResult, patchNode, placeStep, wrapIn } from '../src/team-editor/commands.ts';
import { NodeSettings, type ProfileOption } from '../src/team-editor/NodeSettings.tsx';

// The limit of a Loop in the settings sheet (docs/specs/features/canvas.md, rule 11; the
// structure rule it keeps is team-graph.md rule 4).

function ok(result: EditResult): { draft: EditorDraft; nodeId: string } {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return { draft: result.draft, nodeId: result.nodeId ?? '' };
}
function loopDraft(change: Record<string, unknown> = {}): { draft: EditorDraft; loopId: string } {
  let { draft, nodeId } = ok(placeStep(emptyDraft(), 'agent', { kind: 'empty' }));
  ({ draft } = ok(placeStep(draft, 'agent', { kind: 'after', nodeId })));
  const wrapped = ok(wrapIn(draft, ['agent_1'], 'loop'));
  return { draft: patchNode(wrapped.draft, wrapped.nodeId, change), loopId: wrapped.nodeId };
}

const LIMIT_CODES = new Set([
  'LOOP_MAX_ITERATIONS',
  'LOOP_LIMIT_RECIPE',
  'LOOP_REASONING_OFF',
  'LOOP_UPPER_MODEL',
]);

const PROFILES: ProfileOption[] = [
  { profileId: 'fast', label: 'Fast', available: true },
  { profileId: 'upper', label: 'Upper', available: true },
];

function Sheet({
  editor,
  id,
  profiles,
}: {
  editor: EditorStore;
  id: string;
  profiles: ProfileOption[] | null;
}) {
  const node = useStore(editor, (s) => s.draft.definition.nodes.find((n) => n.id === id));
  if (!node) return null;
  return (
    <NodeSettings
      editor={editor}
      node={node}
      profiles={profiles}
      imageProfiles={null}
      roleSettings={undefined}
      loopSettings={undefined}
    />
  );
}

/** Renders the Loop's sheet and records the limit problems of every draft the editor holds. */
function renderLimit(
  change: Record<string, unknown> = {},
  profiles: ProfileOption[] | null = PROFILES,
  team: (draft: EditorDraft) => EditorDraft = (draft) => draft,
) {
  const { draft, loopId } = loopDraft(change);
  const editor = createEditorStore(team(draft));
  const problems: string[] = [];
  editor.subscribe((state) => {
    for (const d of compileDraft(state.draft).diagnostics)
      if (LIMIT_CODES.has(d.code) && d.nodeId === loopId) problems.push(d.code);
  });
  render(
    <IntlProvider locale="en" messages={messages}>
      <Sheet editor={editor} id={loopId} profiles={profiles} />
    </IntlProvider>,
  );
  const loop = () =>
    editor.getState().draft.definition.nodes.find((n) => n.id === loopId) as LoopNode;
  return { editor, loop, problems };
}

const text = messages.Inspector.loopLimit;
const tab = (name: string) => screen.getByRole('tab', { name });
const limitSwitch = () => screen.getByRole('switch', { name: text.unlimited });

describe('the limit of a Loop', () => {
  it('reads as one group: up to N rounds, and what happens at the limit', () => {
    renderLimit();
    const group = screen.getByRole('group', { name: text.group });
    expect(within(group).getByRole('spinbutton', { name: text.roundsField })).toHaveValue(3);
    expect(within(group).getByRole('tablist', { name: text.atLimit })).toBeInTheDocument();
    expect(tab(text.policy.exhaust)).toHaveAttribute('aria-selected', 'true');
  });

  it('raises reasoning to a level above off, in one write', async () => {
    const user = userEvent.setup();
    const { editor, loop, problems } = renderLimit();
    await act(async () => fireEvent.click(tab(text.policy.raise_reasoning)));
    expect(loop().limitPolicy).toEqual({ kind: 'raise_reasoning', level: 'high' });
    expect(loop().maxIterations).toBe(3);
    await user.click(screen.getByRole('combobox', { name: text.level }));
    const levels = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(levels).not.toContain(messages.Reasoning.level.off);
    expect(levels).toContain(messages.Reasoning.level.max);
    await user.click(screen.getByRole('option', { name: messages.Reasoning.level.xhigh }));
    expect(loop().limitPolicy).toEqual({ kind: 'raise_reasoning', level: 'xhigh' });
    await act(async () => editor.getState().undo());
    expect(loop().limitPolicy).toEqual({ kind: 'raise_reasoning', level: 'high' });
    await act(async () => editor.getState().undo());
    expect(loop().limitPolicy).toBeUndefined();
    expect(problems).toEqual([]);
  });

  it('switches to an upper model from the same list as the role’s model', async () => {
    const user = userEvent.setup();
    const { loop, problems } = renderLimit();
    await act(async () => fireEvent.click(tab(text.policy.upper_model)));
    expect(loop().limitPolicy).toEqual({ kind: 'upper_model', modelProfile: 'fast' });
    const picker = document.querySelector<HTMLElement>('[data-slot="model-picker-trigger"]');
    expect(picker).toHaveAttribute('aria-label', `${text.model}: Fast`);
    await user.click(picker as HTMLElement);
    await user.click(await screen.findByRole('option', { name: /Upper/ }));
    expect(loop().limitPolicy).toEqual({ kind: 'upper_model', modelProfile: 'upper' });
    // Ending again drops the policy; the cap stays.
    await act(async () => fireEvent.click(tab(text.policy.exhaust)));
    expect(loop().limitPolicy).toBeUndefined();
    expect(loop().maxIterations).toBe(3);
    expect(problems).toEqual([]);
  });

  it('turns the cap off, and back on to three rounds that end; undo brings back the rest', async () => {
    const { editor, loop, problems } = renderLimit({
      maxIterations: 5,
      limitPolicy: { kind: 'raise_reasoning', level: 'max' },
    });
    await act(async () => fireEvent.click(limitSwitch()));
    expect(loop()).not.toHaveProperty('maxIterations');
    expect(loop().limitPolicy).toEqual({ kind: 'unlimited' });
    // The count and the choices fold away and can no longer be reached.
    expect(screen.getByRole('spinbutton').closest('[inert]')).not.toBeNull();
    expect(screen.getByRole('tablist').closest('[inert]')).not.toBeNull();
    await act(async () => fireEvent.click(limitSwitch()));
    expect(loop().maxIterations).toBe(3);
    expect(loop()).not.toHaveProperty('limitPolicy');
    // One undo step each way.
    await act(async () => editor.getState().undo());
    expect(loop().limitPolicy).toEqual({ kind: 'unlimited' });
    await act(async () => editor.getState().undo());
    expect(loop()).toMatchObject({
      maxIterations: 5,
      limitPolicy: { kind: 'raise_reasoning', level: 'max' },
    });
    expect(problems).toEqual([]);
  });

  it('gives an unlimited Loop three rounds that end', async () => {
    const { loop, problems } = renderLimit({
      maxIterations: undefined,
      limitPolicy: { kind: 'unlimited' },
    });
    expect(limitSwitch()).toHaveAttribute('aria-checked', 'true');
    await act(async () => fireEvent.click(limitSwitch()));
    expect(loop().maxIterations).toBe(3);
    expect(loop()).not.toHaveProperty('limitPolicy');
    expect(problems).toEqual([]);
  });

  it.each([
    ['nothing', ''],
    ['zero', '0'],
    ['a fraction', '1.5'],
    ['a negative count', '-2'],
    ['a number past the safe range', '99999999999999999999'],
  ])('keeps the count when %s is typed', async (_name, typed) => {
    const { loop } = renderLimit({ maxIterations: 4 });
    const field = screen.getByRole('spinbutton', { name: text.roundsField });
    await act(async () => fireEvent.change(field, { target: { value: typed } }));
    expect(loop().maxIterations).toBe(4);
    await act(async () => fireEvent.change(field, { target: { value: '7' } }));
    expect(loop().maxIterations).toBe(7);
  });

  it('lets a Loop with a review recipe only end, and says why', async () => {
    const { loop, problems } = renderLimit({ reviewRecipe: { recipeId: 'quality' } });
    const reason = text.recipeOnly;
    expect(screen.getByRole('group', { name: text.group })).toHaveAccessibleDescription(reason);
    expect(screen.getByRole('tablist', { name: text.atLimit })).toHaveAccessibleDescription(reason);
    expect(tab(text.policy.raise_reasoning)).toHaveAttribute('aria-disabled', 'true');
    expect(tab(text.policy.upper_model)).toHaveAttribute('aria-disabled', 'true');
    expect(limitSwitch()).toHaveAttribute('aria-disabled', 'true');
    await act(async () => fireEvent.click(tab(text.policy.raise_reasoning)));
    await act(async () => fireEvent.click(tab(text.policy.upper_model)));
    await act(async () => fireEvent.click(limitSwitch()));
    expect(loop().limitPolicy).toBeUndefined();
    expect(loop().maxIterations).toBe(3);
    expect(problems).toEqual([]);
    // The reason is not shown as a caption on the sheet.
    expect(screen.getByText(reason)).toHaveClass('sr-only');
  });

  it.each([
    ['a raised level', { kind: 'raise_reasoning', level: 'high' }],
    ['a model switch', { kind: 'upper_model', modelProfile: 'upper' }],
  ])(
    'shows no choice of its own for %s on a recipe Loop, and ending clears the problem',
    async (_name, limitPolicy) => {
      const { loop, problems } = renderLimit({
        reviewRecipe: { recipeId: 'quality' },
        limitPolicy,
      });
      expect(screen.queryByRole('combobox', { name: text.level })).toBeNull();
      expect(document.querySelector('[data-slot="model-picker-trigger"]')).toBeNull();
      expect(screen.queryByRole('textbox', { name: text.model })).toBeNull();
      await act(async () => fireEvent.click(tab(text.policy.exhaust)));
      expect(loop()).not.toHaveProperty('limitPolicy');
      expect(problems).toEqual([]);
    },
  );

  it('picks a model that can run before one that cannot', async () => {
    const { loop } = renderLimit({}, [
      { profileId: 'signed_out', label: 'Signed out', available: false },
      { profileId: 'ready', label: 'Ready', available: true },
    ]);
    await act(async () => fireEvent.click(tab(text.policy.upper_model)));
    expect(loop().limitPolicy).toEqual({ kind: 'upper_model', modelProfile: 'ready' });
  });

  it('types the model when no model list is known, keeping it when the id is blank or malformed', async () => {
    const { loop } = renderLimit({ limitPolicy: { kind: 'upper_model', modelProfile: 'x' } }, null);
    const field = screen.getByRole('textbox', { name: text.model });
    for (const typed of ['', 'two words', '9lives'])
      await act(async () => fireEvent.change(field, { target: { value: typed } }));
    expect(loop().limitPolicy).toEqual({ kind: 'upper_model', modelProfile: 'x' });
    await act(async () => fireEvent.change(field, { target: { value: 'bigger' } }));
    expect(loop().limitPolicy).toEqual({ kind: 'upper_model', modelProfile: 'bigger' });
  });

  it('cannot switch models when there is no model to switch to', async () => {
    const { loop } = renderLimit({}, null, (draft) => ({
      ...draft,
      definition: { ...draft.definition, roles: [] },
    }));
    expect(tab(text.policy.upper_model)).toHaveAttribute('aria-disabled', 'true');
    await act(async () => fireEvent.click(tab(text.policy.upper_model)));
    expect(loop()).not.toHaveProperty('limitPolicy');
  });
});
