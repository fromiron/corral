import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useMemo } from 'react';
import { expect, waitFor, within } from 'storybook/test';
import { IntlProvider } from 'use-intl';
import { StudioStoresProvider } from '../context.tsx';
import { connectCapability, type EditorDraft, emptyDraft } from '../editor/model.ts';
import { createEditorStore } from '../editor/store.ts';
import messages from '../messages/en.json' with { type: 'json' };
import koMessages from '../messages/ko.json' with { type: 'json' };
import { sessionStore } from '../stories/fixtures.tsx';
import { connectPorts, type EditResult, patchNode, placeStep, watchAgent } from './commands.ts';
import type { ProfileOption } from './NodeSettings.tsx';
import { TeamEditor } from './TeamEditor.tsx';

// An advisor in the team editor: a row above the flow, watching two agents through dash-dot
// advise links (docs/specs/features/canvas.md rules 2, 4 and 11).

function ok(result: EditResult): { draft: EditorDraft; nodeId: string } {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return { draft: result.draft, nodeId: result.nodeId ?? '' };
}

/**
 * Draft → Review → Revise → Output, and an advisor watching Draft and Revise. With `branch`,
 * Draft also leads to Second opinion below Review, and the advisor watches only that. With
 * `callable`, Revise calls Sources, a callable agent under the flow, and the advisor watches it.
 */
function team(watch: boolean, branch = false, callable = false) {
  let { draft, nodeId } = ok(
    placeStep(emptyDraft('advised', 'Advised team'), 'agent', { kind: 'empty' }),
  );
  for (let i = 0; i < 2; i++)
    ({ draft, nodeId } = ok(placeStep(draft, 'agent', { kind: 'after', nodeId })));
  ({ draft } = ok(placeStep(draft, 'output', { kind: 'after', nodeId })));
  const labels: Record<string, string> = { agent_1: 'Draft', agent_2: 'Review', agent_3: 'Revise' };
  draft = {
    ...draft,
    definition: {
      ...draft.definition,
      nodes: draft.definition.nodes.map((n) =>
        labels[n.id] ? { ...n, label: labels[n.id] as string } : n,
      ),
    },
  };
  if (branch) {
    const second = ok(placeStep(draft, 'agent', { kind: 'empty' }));
    const linked = ok(
      connectPorts(second.draft, {
        source: 'agent_1',
        sourcePort: 'out',
        target: second.nodeId,
        targetPort: 'in',
      }),
    ).draft;
    const named = patchNode(linked, second.nodeId, { label: 'Second opinion' });
    return ok(placeStep(named, 'observer', { kind: 'after', nodeId: second.nodeId })).draft;
  }
  if (callable) {
    const helper = ok(placeStep(draft, 'agent', { kind: 'empty' }));
    const named = patchNode(helper.draft, helper.nodeId, {
      label: 'Sources',
      invocation: 'callable',
    });
    const called = connectCapability(named, 'agent_3', helper.nodeId, 'delegate');
    if (!called.ok) throw new Error(called.reason);
    return ok(placeStep(called.draft, 'observer', { kind: 'after', nodeId: helper.nodeId })).draft;
  }
  const added = ok(
    placeStep(draft, 'observer', watch ? { kind: 'after', nodeId: 'agent_1' } : { kind: 'empty' }),
  );
  return watch ? ok(watchAgent(added.draft, added.nodeId, 'agent_3')).draft : added.draft;
}

const profiles: ProfileOption[] = [
  { profileId: 'model-a', label: 'Model A', modelId: 'model-a', available: true },
];

function AdvisedTeam({
  watch,
  select,
  dark,
  branch,
  callable,
}: {
  watch: boolean;
  select: boolean;
  dark: boolean;
  branch?: boolean;
  callable?: boolean;
}) {
  const editor = useMemo(
    () => createEditorStore(team(watch, branch, callable)),
    [watch, branch, callable],
  );
  const session = useMemo(() => sessionStore(), []);
  useEffect(() => {
    if (select) editor.getState().select('advisor_1');
  }, [editor, select]);
  return (
    <div className={dark ? 'dark bg-background text-foreground' : 'bg-background text-foreground'}>
      <div style={{ height: 640 }}>
        <StudioStoresProvider editor={editor} session={session}>
          <TeamEditor editor={editor} profiles={profiles} />
        </StudioStoresProvider>
      </div>
    </div>
  );
}

const meta = {
  title: 'Team editor/Advisor',
  component: AdvisedTeam,
  args: { watch: true, select: false, dark: false },
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof AdvisedTeam>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The settings sheet once it has slid in, so the accessibility check reads settled colours. */
async function openSheet(canvasElement: HTMLElement, name = messages.TeamEditor.inspector) {
  const sheet = await within(canvasElement).findByRole('complementary', { name });
  await waitFor(() => expect(getComputedStyle(sheet.parentElement as Element).opacity).toBe('1'));
  await waitFor(() =>
    expect(getComputedStyle(sheet.parentElement as Element).transform).toMatch(
      /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/,
    ),
  );
  return sheet;
}

const advisorCard = (canvasElement: HTMLElement) =>
  canvasElement.querySelector('[data-team-canvas] [data-node="advisor_1"]') as HTMLElement;

/** The advisor sits above the flow and draws one advise link to each agent it watches. */
export const WatchingTwo: Story = {
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(advisorCard(canvasElement)).toBeTruthy());
    const advisor = advisorCard(canvasElement).getBoundingClientRect();
    const draft = canvasElement
      .querySelector('[data-team-canvas] [data-node="agent_1"]')
      ?.getBoundingClientRect();
    await expect(advisor.bottom).toBeLessThan(draft?.top ?? 0);
    // The dash-dot lines carry no name.
    await expect(within(canvasElement).queryAllByText(messages.TeamEditor.links.advise)).toEqual(
      [],
    );
    await expect(canvasElement.querySelector('[data-port^="advisor_1:"]')).toBeNull();
  },
};

/** Its sheet: read tools, the two agents it watches as chips, and the review interval. */
export const Settings: Story = {
  args: { select: true },
  play: async ({ canvasElement }) => {
    const sheet = await openSheet(canvasElement);
    const inSheet = within(sheet);
    await expect(inSheet.getByRole('button', { name: 'Stop watching Draft' })).toBeVisible();
    await expect(inSheet.getByRole('button', { name: 'Stop watching Revise' })).toBeVisible();
    await expect(
      inSheet.getByRole('spinbutton', { name: messages.Inspector.reviewField }),
    ).toHaveValue(3);
    await expect(inSheet.queryByRole('group', { name: messages.Inspector.inputs })).toBeNull();
  },
};

/** An advise link, selected: its sheet names the advisor and the agent it watches. */
export const LinkSelected: Story = {
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(advisorCard(canvasElement)).toBeTruthy());
    const hit = canvasElement.querySelector('[data-edge="link_1"] path') as SVGPathElement;
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const sheet = await openSheet(canvasElement);
    await expect(within(sheet).getByText(messages.TeamEditor.connection)).toBeVisible();
    await expect(within(sheet).getByText('Outrider')).toBeVisible();
  },
};

/** An advisor watching no one says so on its card. */
export const WatchingNobody: Story = {
  args: { watch: false, select: true },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(advisorCard(canvasElement)).toBeTruthy());
    const mark = advisorCard(canvasElement).querySelector('[data-problem]');
    await expect(mark?.getAttribute('title')).toContain('Outrider watches no one');
    const sheet = await openSheet(canvasElement);
    await expect(within(sheet).getByText(/Outrider watches no one/)).toBeInTheDocument();
  },
};

export const WatchingTwoDark: Story = { ...WatchingTwo, args: { dark: true } };
export const SettingsDark: Story = { ...Settings, args: { select: true, dark: true } };
export const LinkSelectedDark: Story = { ...LinkSelected, args: { dark: true } };
export const WatchingNobodyDark: Story = {
  ...WatchingNobody,
  args: { watch: false, select: true, dark: true },
};

/** The sheet in Korean: the review interval reads as one sentence around its field. */
export const SettingsKorean: Story = {
  args: { select: true },
  decorators: [
    (Story) => (
      <IntlProvider locale="ko" messages={koMessages} timeZone="UTC">
        {Story()}
      </IntlProvider>
    ),
  ],
  play: async ({ canvasElement }) => {
    const ko = koMessages.Inspector;
    const sheet = await openSheet(canvasElement, koMessages.TeamEditor.inspector);
    const field = within(sheet).getByRole('spinbutton', { name: ko.reviewField });
    const before = within(sheet).getByText(ko.reviewEvery).getBoundingClientRect();
    const after = within(sheet).getByText('번마다 검토').getBoundingClientRect();
    const box = field.getBoundingClientRect();
    await expect(before.right).toBeLessThanOrEqual(box.left);
    await expect(after.left).toBeGreaterThanOrEqual(box.right);
  },
};

/**
 * Watching the lower branch of a fan-out: the line goes round the card above it, down the gap
 * beside the column, and behind no card but its ends.
 */
export const WatchingLowerBranch: Story = {
  args: { branch: true },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(advisorCard(canvasElement)).toBeTruthy());
    const lines = canvasElement.querySelector('[data-team-canvas] svg') as Element;
    const review = canvasElement.querySelector('[data-team-canvas] [data-node="agent_2"]');
    await expect(
      lines.compareDocumentPosition(review as Element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  },
};

export const WatchingLowerBranchDark: Story = {
  ...WatchingLowerBranch,
  args: { branch: true, dark: true },
};

/** Watching a callable agent under the flow: the line goes round the flow card above it. */
export const WatchingCallable: Story = {
  args: { callable: true },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(advisorCard(canvasElement)).toBeTruthy());
    await expect(
      canvasElement.querySelector('[data-team-canvas] [data-node="agent_4"]'),
    ).toBeTruthy();
  },
};
