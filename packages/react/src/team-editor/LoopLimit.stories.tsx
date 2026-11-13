import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, within } from 'storybook/test';
import { IntlProvider } from 'use-intl';
import { useStore } from 'zustand';
import { type EditorDraft, emptyDraft } from '../editor/model.ts';
import { createEditorStore } from '../editor/store.ts';
import messages from '../messages/en.json' with { type: 'json' };
import koMessages from '../messages/ko.json' with { type: 'json' };
import { type EditResult, patchNode, placeStep, wrapIn } from './commands.ts';
import { NodeSettings, type ProfileOption } from './NodeSettings.tsx';

// The limit of a Loop in the team editor's settings sheet, one state per story, at the sheet's
// width (docs/specs/features/canvas.md, rule 14).

function ok(result: EditResult): { draft: EditorDraft; nodeId: string } {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return { draft: result.draft, nodeId: result.nodeId ?? '' };
}
function loopDraft(change: Record<string, unknown>) {
  let { draft, nodeId } = ok(placeStep(emptyDraft(), 'agent', { kind: 'empty' }));
  ({ draft } = ok(placeStep(draft, 'agent', { kind: 'after', nodeId })));
  const wrapped = ok(wrapIn(draft, ['agent_1'], 'loop'));
  return { draft: patchNode(wrapped.draft, wrapped.nodeId, change), loopId: wrapped.nodeId };
}

const profiles: ProfileOption[] = [
  { profileId: 'fast', label: 'Fast', modelId: 'model-fast', available: true },
  { profileId: 'upper', label: 'Upper', modelId: 'model-upper', available: true },
];

function LoopSheet({ change }: { change: Record<string, unknown> }) {
  const { editor, loopId } = useMemo(() => {
    const { draft, loopId } = loopDraft(change);
    return { editor: createEditorStore(draft), loopId };
  }, [change]);
  const node = useStore(editor, (s) => s.draft.definition.nodes.find((n) => n.id === loopId));
  if (!node) return null;
  return (
    <div className="w-[344px] max-w-full">
      <NodeSettings
        editor={editor}
        node={node}
        profiles={profiles}
        imageProfiles={null}
        roleSettings={undefined}
        loopSettings={undefined}
      />
    </div>
  );
}

const text = messages.Inspector.loopLimit;

const meta = {
  title: 'Team editor/Loop limit',
  component: LoopSheet,
  args: { change: {} },
} satisfies Meta<typeof LoopSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Ends: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('group', { name: text.group })).toBeVisible();
    await expect(canvas.getByRole('tab', { name: text.policy.exhaust })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  },
};

export const RaisesReasoning: Story = {
  args: { change: { limitPolicy: { kind: 'raise_reasoning', level: 'high' } } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('combobox', { name: text.level })).toBeVisible();
  },
};

export const SwitchesModel: Story = {
  args: { change: { limitPolicy: { kind: 'upper_model', modelProfile: 'upper' } } },
};

export const NoLimit: Story = {
  args: { change: { maxIterations: undefined, limitPolicy: { kind: 'unlimited' } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('switch', { name: text.unlimited })).toBeChecked();
    await expect(canvas.queryByRole('tablist')).toBeNull();
  },
};

export const WithReviewRecipe: Story = {
  args: { change: { reviewRecipe: { recipeId: 'quality' } } },
  play: async ({ canvasElement }) => {
    const tab = within(canvasElement).getByRole('tab', { name: text.policy.upper_model });
    await expect(tab).toHaveAttribute('aria-disabled', 'true');
  },
};

export const Korean: Story = {
  args: { change: { limitPolicy: { kind: 'raise_reasoning', level: 'high' } } },
  decorators: [
    (Story) => (
      <IntlProvider locale="ko" messages={koMessages} timeZone="UTC">
        {Story()}
      </IntlProvider>
    ),
  ],
  play: async ({ canvasElement }) => {
    const group = within(canvasElement).getByRole('group', {
      name: koMessages.Inspector.loopLimit.group,
    });
    // The sentence and its choices stay inside the sheet's width.
    await expect(group.scrollWidth).toBeLessThanOrEqual(group.clientWidth);
  },
};

export const Dark: Story = {
  args: { change: { limitPolicy: { kind: 'upper_model', modelProfile: 'upper' } } },
  decorators: [(Story) => <div className="dark bg-background p-3 text-foreground">{Story()}</div>],
};
