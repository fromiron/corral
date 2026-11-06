import type { AutoModelChoice } from '@corral/contracts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, fn, waitFor, within } from 'storybook/test';
import { AutoModelMenu } from '../../../../apps/studio/src/workbench/AutoModelMenu.tsx';
import type { ProfileInfo } from '../../../../apps/studio/src/workbench/useModels.ts';

const profiles: ProfileInfo[] = [
  {
    profileId: 'first',
    label: 'Provider A · Model A',
    modelId: 'model-a',
    available: true,
    reasoningCapabilities: { providerDefault: true, levels: ['low', 'medium', 'high', 'xhigh'] },
  },
  {
    profileId: 'second',
    label: 'Provider B · Model B',
    modelId: 'model-b',
    available: false,
    reasoningCapabilities: { providerDefault: false, levels: ['low'] },
  },
];

async function waitForPopup(canvasElement: HTMLElement) {
  const dialog = await within(canvasElement.ownerDocument.body).findByRole('dialog');
  // The kit retains its entrance fade. Contrast is measured at its settled state.
  await waitFor(() => {
    let element: HTMLElement | null = within(dialog).getByRole('listbox');
    while (element) {
      expect(getComputedStyle(element).opacity).toBe('1');
      element = element.parentElement;
    }
  });
  const bounds = dialog.getBoundingClientRect();
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
  expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
}

const meta = {
  title: 'Composer/ModelPicker',
  component: AutoModelMenu,
  args: {
    profiles,
    value: { modelProfile: 'first', reasoning: { mode: 'fixed', level: 'high' } },
    open: false,
    disabled: false,
    showReasoning: true,
    onChange: fn(),
    onOpenChange: fn(),
  },
  render: function ControlledPicker(args) {
    const [value, setValue] = useState<AutoModelChoice>(args.value);
    const [open, setOpen] = useState(args.open);
    return (
      <div className="h-24 w-80 max-w-full overflow-hidden p-3" data-testid="composer-scroll">
        <AutoModelMenu
          {...args}
          value={value}
          open={open}
          onChange={(next) => {
            setValue(next);
            args.onChange(next);
          }}
          onOpenChange={(next) => {
            setOpen(next);
            args.onOpenChange(next);
          }}
        />
      </div>
    );
  },
  play: async ({ canvasElement }) => waitForPopup(canvasElement),
} satisfies Meta<typeof AutoModelMenu>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = { args: { open: true, value: { modelProfile: 'first' } } };

export const FixedEffort: Story = { args: { open: true } };

export const AllEfforts: Story = {
  args: {
    open: true,
    profiles: profiles.map((profile) => ({
      ...profile,
      reasoningCapabilities: {
        providerDefault: true,
        levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      },
    })),
  },
  play: async ({ canvasElement, userEvent, args }) => {
    await waitForPopup(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const tabs = page.getByRole('tablist', { name: 'Effort' });
    const high = within(tabs).getByRole('tab', { name: /^High$/ });
    high.focus();
    await userEvent.keyboard('{End}');
    await expect(within(tabs).getByRole('tab', { name: 'Maximum' })).toHaveFocus();
    await expect(args.onChange).toHaveBeenLastCalledWith({
      modelProfile: 'first',
      reasoning: { mode: 'fixed', level: 'max' },
    });
    await waitForPopup(canvasElement);
  },
};

export const MissingProfile: Story = {
  args: {
    open: true,
    value: { modelProfile: 'removed-profile', reasoning: { mode: 'fixed', level: 'max' } },
  },
};

export const KeyboardAndContainment: Story = {
  play: async ({ canvasElement, args, userEvent }) => {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const trigger = canvas.getByRole('button', { name: 'Model' });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    const dialog = await page.findByRole('dialog', { name: 'Model settings' });
    await waitFor(() => expect(dialog).toBeVisible());
    expect(canvas.getByTestId('composer-scroll').contains(dialog)).toBe(false);
    const models = within(dialog).getByRole('listbox', { name: 'Model' });
    await waitFor(() => expect(models).toHaveFocus());
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(args.onChange).toHaveBeenCalledWith({
      modelProfile: 'second',
      reasoning: { mode: 'fixed', level: 'high' },
    });
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(within(dialog).getByRole('tab', { name: 'High · Unsupported' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Low' }));
    await expect(args.onChange).toHaveBeenLastCalledWith({
      modelProfile: 'second',
      reasoning: { mode: 'fixed', level: 'low' },
    });
    const policy = within(dialog).getByRole('combobox', { name: 'Reasoning effort' });
    await userEvent.click(policy);
    await expect(
      await page.findByRole('option', { name: 'Keep existing behavior (unset)' }),
    ).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(policy).toHaveAttribute('aria-expanded', 'false'));
    await expect(dialog).toBeVisible();
    await waitFor(() => expect(policy).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(page.queryByRole('dialog')).toBeNull());
    await expect(trigger).toHaveFocus();
  },
};

export const Dark: Story = {
  args: { open: true },
  decorators: [
    function DarkTheme(Story) {
      useEffect(() => {
        const root = document.documentElement;
        const previous = root.className;
        root.classList.remove('light');
        root.classList.add('dark');
        return () => {
          root.className = previous;
        };
      }, []);
      return <div className="bg-background p-3">{Story()}</div>;
    },
  ],
};
