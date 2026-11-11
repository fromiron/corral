import type { AutoModelChoice } from '@corral/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { AutoModelMenu } from '../../../apps/studio/src/workbench/AutoModelMenu.tsx';
import type { ProfileInfo } from '../../../apps/studio/src/workbench/useModels.ts';
import { DesignKitProvider } from '../src/design-kit/index.ts';
import messages from '../src/messages/en.json' with { type: 'json' };

const profiles: ProfileInfo[] = [
  {
    profileId: 'model-a',
    label: 'Provider A · Model A',
    available: true,
    reasoningCapabilities: { providerDefault: true, levels: ['low', 'medium', 'high', 'xhigh'] },
  },
  {
    profileId: 'model-b',
    label: 'Provider B · Model B',
    available: false,
    reasoningCapabilities: { providerDefault: false, levels: ['low'] },
  },
];

function show(
  value: AutoModelChoice = { modelProfile: 'model-a', reasoning: { mode: 'fixed', level: 'high' } },
  options: { disabled?: boolean; showReasoning?: boolean } = {},
) {
  const onChange = vi.fn();
  const onOpenChange = vi.fn();
  const result = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <DesignKitProvider>
        <div data-testid="composer-scroll" style={{ overflow: 'hidden' }}>
          <AutoModelMenu
            value={value}
            profiles={profiles}
            showReasoning={options.showReasoning ?? true}
            disabled={options.disabled ?? false}
            open
            onOpenChange={onOpenChange}
            onChange={onChange}
          />
        </div>
      </DesignKitProvider>
    </IntlProvider>,
  );
  return { ...result, onChange, onOpenChange };
}

describe('composer model picker', () => {
  it('shows actual model and reasoning choices together without unsupported demo controls', async () => {
    const user = userEvent.setup();
    show();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('listbox', { name: 'Model' })).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: 'Reasoning effort' })).toBeInTheDocument();
    expect(within(dialog).getByRole('tablist', { name: 'Effort' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('radiogroup')).toBeNull();
    await user.click(within(dialog).getByRole('combobox', { name: 'Reasoning effort' }));
    for (const name of ['Provider default', 'Extra high', 'Automatic', 'Chosen per request'])
      expect(await screen.findByRole('option', { name })).toBeInTheDocument();
    expect(within(dialog).queryByText('Speed')).toBeNull();
    expect(within(dialog).queryByText('Quality')).toBeNull();
    expect(within(dialog).queryByText('Cost')).toBeNull();
    expect(within(dialog).queryByRole('switch')).toBeNull();
    expect(screen.getByTestId('composer-scroll').contains(dialog)).toBe(false);
  });

  it('preserves the saved reasoning when choosing another model and keeps settings open', () => {
    const { onChange, onOpenChange } = show();
    fireEvent.click(screen.getByRole('option', { name: /Provider B · Model B/ }));
    expect(onChange).toHaveBeenCalledWith({
      modelProfile: 'model-b',
      reasoning: { mode: 'fixed', level: 'high' },
    });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole('option', { name: /Provider A · Model A/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('keeps a missing profile and unsupported requested effort visible rather than falling back', () => {
    show({ modelProfile: 'removed-profile', reasoning: { mode: 'fixed', level: 'max' } });
    const missing = screen.getByRole('option', { name: /removed-profile/ });
    expect(missing).toHaveAttribute('aria-selected', 'true');
    expect(missing).toHaveAttribute('aria-disabled', 'true');
    const effort = screen.getByRole('tab', { name: 'Maximum · Unsupported' });
    expect(effort).toHaveAttribute('aria-selected', 'true');
    expect(effort).toHaveAttribute('aria-disabled', 'true');
  });

  it('does not allow capability-incompatible or pending changes', () => {
    const { onChange } = show(
      { modelProfile: 'model-b', reasoning: { mode: 'fixed', level: 'low' } },
      { disabled: true },
    );
    fireEvent.click(screen.getByRole('option', { name: /Provider A · Model A/ }));
    fireEvent.click(screen.getByRole('tab', { name: 'Low' }));
    expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Model' })).toBeDisabled();
  });

  it('keeps an unsupported automatic setting selected but only accepts supported replacements', async () => {
    const user = userEvent.setup();
    const { onChange } = show({ modelProfile: 'model-b', reasoning: { mode: 'auto' } });
    expect(screen.queryByRole('tablist')).toBeNull();
    await user.click(screen.getByRole('combobox', { name: 'Reasoning effort' }));
    const automatic = await screen.findByRole('option', { name: 'Automatic' });
    expect(automatic).toHaveAttribute('aria-selected', 'true');
    expect(automatic).toHaveAttribute('aria-disabled', 'true');
    for (const name of ['Provider default', 'Automatic', 'Chosen per request'])
      fireEvent.click(screen.getByRole('option', { name }));
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('option', { name: 'Low' }));
    expect(onChange).toHaveBeenCalledWith({
      modelProfile: 'model-b',
      reasoning: { mode: 'fixed', level: 'low' },
    });
  });

  it('changes reasoning without changing the model and leaves unset as absent', async () => {
    const user = userEvent.setup();
    const { onChange } = show();
    const policy = screen.getByRole('combobox', { name: 'Reasoning effort' });
    await user.click(policy);
    await user.click(await screen.findByRole('option', { name: 'Chosen per request' }));
    expect(onChange).toHaveBeenLastCalledWith({
      modelProfile: 'model-a',
      reasoning: { mode: 'route' },
    });
    await waitFor(() => expect(policy).toHaveAttribute('aria-expanded', 'false'));
    await user.click(policy);
    await user.click(await screen.findByRole('option', { name: 'Keep existing behavior (unset)' }));
    expect(onChange).toHaveBeenLastCalledWith({ modelProfile: 'model-a' });
  });

  it('omits reasoning controls for a context that does not use them', () => {
    show(undefined, { showReasoning: false });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // The model search is the one combobox left.
    expect(screen.getAllByRole('combobox').map((box) => box.getAttribute('aria-label'))).toEqual([
      'Search models',
    ]);
    expect(screen.queryByRole('combobox', { name: 'Reasoning effort' })).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
  });
});
