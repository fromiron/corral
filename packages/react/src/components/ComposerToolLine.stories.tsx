import type { AutoModelChoice } from '@corral/contracts';
import type { CorralSummary } from '@corral/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { expect, fn, within } from 'storybook/test';
import { AdvisorControl } from '../../../../apps/studio/src/workbench/session/composer/AdvisorControl.tsx';
import {
  ComposerCard,
  type SendTarget,
} from '../../../../apps/studio/src/workbench/session/composer/ComposerCard.tsx';
import {
  AttachMenu,
  RequestTools,
  TeamChoice,
} from '../../../../apps/studio/src/workbench/session/composer/ComposerTools.tsx';
import type { ProfileInfo } from '../../../../apps/studio/src/workbench/useModels.ts';
import { OverviewStoryRouter } from '../../../../apps/studio/src/workbench/widgets/OverviewWidgets.story-fixture.tsx';

// composer-flow.md "화면 틀": the tool line keeps one line's height whatever it holds. A long
// model name gives way before its neighbours do: the icon buttons keep their square, the key hint
// leaves whole, and the chip gives way before the permission select is cut, down to a stub that
// clips its own marks.

const LONG = 'provider-a/reasoning-model-2026-10-preview-long';

function profilesNamed(label: string): ProfileInfo[] {
  return [
    {
      profileId: 'first',
      label,
      modelId: 'model-a',
      available: true,
      reasoningCapabilities: { providerDefault: true, levels: ['low', 'medium', 'high'] },
    },
  ];
}

const target: SendTarget = {
  badge: null,
  row: 'idle',
  keys: { send: 'new', interrupt: 'new', queue: 'new' },
  meaning: 'Send',
  menu: null,
  sendDisabled: true,
  send: () => {},
};

function ToolLine({ width, name, team }: { width: number; name: string; team?: string }) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [choice, setChoice] = useState<AutoModelChoice>({ modelProfile: 'first' });
  const profiles = profilesNamed(name);
  const corral = team
    ? ({ corralId: 'team', name: team, definitionRevision: 1 } as CorralSummary)
    : null;
  return (
    <OverviewStoryRouter>
      <div style={{ width }} data-testid="column">
        <ComposerCard
          label="Request"
          placeholder="Ask"
          inputRef={inputRef}
          text={text}
          onText={setText}
          sendKey="enter"
          sendLabel="Send"
          target={target}
          menus={null}
          attach={
            <AttachMenu
              onAddReference={fn()}
              serverMode
              imagesDisabled={false}
              textDisabled={false}
              onAttachImages={fn()}
              onAttachText={fn()}
              onAttachMaterials={fn()}
            />
          }
          afterTarget={
            <>
              <TeamChoice
                projectId="project"
                team={corral}
                teamMode="none"
                corrals={corral ? [corral] : []}
                isAuto={false}
                disabled={false}
                open={false}
                onOpenChange={() => {}}
                onTeamMode={() => {}}
                onTeam={() => {}}
              />
              <AdvisorControl
                value={null}
                unknown={false}
                onRecheck={fn()}
                defaultModel="first"
                profiles={profiles}
                saving={false}
                disabled={false}
                problem={null}
                onChange={fn()}
              />
            </>
          }
          settings={
            <RequestTools
              only="settings"
              intent="next"
              showModel
              browserMode={false}
              autoChoice={choice}
              profiles={profiles}
              busy={false}
              modelOpen={false}
              onModelOpenChange={() => {}}
              onAutoChange={setChoice}
              permissionMode={undefined}
              onPermissionMode={() => {}}
              voice={null as never}
              voiceTarget={null as never}
              voiceLabel=""
              onTranscript={async () => ({}) as never}
            />
          }
        />
      </div>
    </OverviewStoryRouter>
  );
}

const meta = {
  title: 'Composer/ToolLine',
  component: ToolLine,
  args: { width: 672, name: LONG },
} satisfies Meta<typeof ToolLine>;
export default meta;
type Story = StoryObj<typeof meta>;

function parts(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const model = canvas.getByRole('button', { name: 'Model' });
  return {
    attach: canvas.getByRole('button', { name: 'Attachments' }).getBoundingClientRect(),
    advisor: canvasElement.querySelector('[data-slot="composer-advisor"]')?.getBoundingClientRect(),
    model: model.getBoundingClientRect(),
    name: model.querySelector<HTMLElement>('[data-slot="model-picker-name"]'),
    hint: canvasElement.querySelector('[data-slot="composer-keys"]')?.getBoundingClientRect(),
  };
}

/** Each icon button keeps its square, and the hint that cannot show whole takes no width. */
function expectNeighboursHold(canvasElement: HTMLElement) {
  expect(window.matchMedia('(min-width: 40rem)').matches).toBe(true);
  const { attach, advisor, model, name, hint } = parts(canvasElement);
  expect(attach.width).toBeCloseTo(attach.height, 0);
  expect(advisor?.width).toBeCloseTo(advisor?.height ?? 0, 0);
  expect(model.height).toBeLessThanOrEqual(attach.height);
  expect(name?.title).toBe(LONG);
  // The name is cut, so the hint has given its room up entirely.
  expect(name?.scrollWidth).toBeGreaterThan(name?.clientWidth ?? 0);
  expect(hint?.width ?? -1).toBeLessThan(1);
  return { name };
}

export const LongNameWide: Story = {
  play: async ({ canvasElement }) => {
    expectNeighboursHold(canvasElement);
  },
};

export const LongNameGivesWayFirst: Story = {
  args: { width: 400 },
  play: async ({ canvasElement }) => {
    const { name } = expectNeighboursHold(canvasElement);
    // Short of room the chip gives way before anything else is cut: the permission select, the
    // last of the line's settings, still ends inside the tool line's clip.
    const slot = canvasElement
      .querySelector('[class*="sm:overflow-x-clip"]')
      ?.getBoundingClientRect();
    const selects = canvasElement.querySelectorAll('[data-slot="select-trigger"]');
    const permission = selects[selects.length - 1]?.getBoundingClientRect();
    expect(permission?.right ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      (slot?.right ?? 0) + 0.5,
    );
    // The name is cut hard to make that room.
    expect(name?.clientWidth ?? 0).toBeLessThan((name?.scrollWidth ?? 0) / 4);
  },
};

export const ShortNameShowsTheHint: Story = {
  args: { name: 'Model A' },
  play: async ({ canvasElement }) => {
    const { attach, name, hint } = parts(canvasElement);
    expect(attach.width).toBeCloseTo(attach.height, 0);
    expect(name?.scrollWidth).toBeLessThanOrEqual(name?.clientWidth ?? 0);
    expect(hint?.width ?? 0).toBeGreaterThan(20);
    // The hint sits whole on its first line, inside its box.
    const keys = canvasElement.querySelector('[data-slot="composer-keys-hint"]');
    const shown = keys?.getBoundingClientRect();
    expect(shown?.top).toBeCloseTo(hint?.top ?? -1, 0);
    expect(shown?.right ?? 0).toBeLessThanOrEqual((hint?.right ?? 0) + 0.5);
  },
};

export const ChipCutToAStub: Story = {
  args: { width: 352 },
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole('button', { name: 'Model' });
    const slot = canvasElement
      .querySelector('[class*="sm:overflow-x-clip"]')
      ?.getBoundingClientRect();
    const selects = canvasElement.querySelectorAll('[data-slot="select-trigger"]');
    const permission = selects[selects.length - 1]?.getBoundingClientRect();
    // Even the chip's own marks give way before the permission select is cut,
    expect(permission?.right ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      (slot?.right ?? 0) + 0.5,
    );
    // and what the chip cannot fit is clipped at its own edge, never drawn over its neighbour.
    const bounds = trigger.getBoundingClientRect();
    const spills = [...trigger.children].some(
      (child) => child.getBoundingClientRect().right > bounds.right + 0.5,
    );
    if (spills) expect(getComputedStyle(trigger).overflowX).toMatch(/clip|hidden/);
    expect(spills).toBe(true);
  },
};

const TEAM = 'Release review crew for the October branch';

// A 516px column gives the 464px left slot of a 632px conversation column in the app.
export const LongTeamAndModelNames: Story = {
  args: { width: 516, team: TEAM },
  play: async ({ canvasElement }) => {
    expect(window.matchMedia('(min-width: 40rem)').matches).toBe(true);
    const canvas = within(canvasElement);
    const slot = canvasElement
      .querySelector('[class*="sm:overflow-x-clip"]')
      ?.getBoundingClientRect() as DOMRect;
    const selects = [
      ...canvasElement.querySelectorAll<HTMLElement>('[data-slot="select-trigger"]'),
    ];
    const teamChip = selects[0] as HTMLElement;
    const permission = (selects[selects.length - 1] as HTMLElement).getBoundingClientRect();
    // The permission select ends inside the line and nothing lies over it.
    expect(permission.right).toBeLessThanOrEqual(slot.right + 0.5);
    const atPermission = document.elementFromPoint(
      permission.left + permission.width / 2,
      permission.top + permission.height / 2,
    );
    expect(selects[selects.length - 1]?.contains(atPermission)).toBe(true);
    // The team name is cut; its whole text is the term tooltip's state, which is also the chip's
    // description, and the chip keeps its own name.
    expect(teamChip).toHaveAccessibleName('Corral');
    expect(teamChip).toHaveAccessibleDescription(expect.stringContaining(TEAM));
    const teamName = [...teamChip.querySelectorAll<HTMLElement>('span')].find(
      (el) => el.textContent === TEAM && el.children.length === 0,
    );
    expect(teamName?.scrollWidth).toBeGreaterThan(teamName?.clientWidth ?? 0);
    // The model chip still shows its marks.
    const model = canvas.getByRole('button', { name: 'Model' }).getBoundingClientRect();
    expect(model.width).toBeGreaterThanOrEqual(56);
    // One row.
    const attach = canvas.getByRole('button', { name: 'Attachments' }).getBoundingClientRect();
    for (const box of [model, permission, teamChip.getBoundingClientRect()])
      expect(box.top + box.height / 2).toBeCloseTo(attach.top + attach.height / 2, 0);
  },
};
