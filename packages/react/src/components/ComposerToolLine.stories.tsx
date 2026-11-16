import type { AutoModelChoice } from '@corral/contracts';
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
} from '../../../../apps/studio/src/workbench/session/composer/ComposerTools.tsx';
import type { ProfileInfo } from '../../../../apps/studio/src/workbench/useModels.ts';
import { Select } from '../design-kit/index.ts';

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

function ToolLine({ width, name }: { width: number; name: string }) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [choice, setChoice] = useState<AutoModelChoice>({ modelProfile: 'first' });
  const profiles = profilesNamed(name);
  return (
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
            {/* The team chip's kit Select, as TeamChoice draws it. */}
            <Select
              variant="chip"
              label="Team"
              value="none"
              onValueChange={() => {}}
              options={[{ value: 'none', label: 'No team' }]}
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
