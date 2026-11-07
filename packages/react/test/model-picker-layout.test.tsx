import { render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { expect, it, vi } from 'vitest';
import { AutoModelMenu } from '../../../apps/studio/src/workbench/AutoModelMenu.tsx';
import { DesignKitProvider, ModelPicker } from '../src/design-kit/index.ts';
import messages from '../src/messages/en.json' with { type: 'json' };

function show(fixed: boolean) {
  return render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <DesignKitProvider>
        <AutoModelMenu
          profiles={[
            {
              profileId: 'model',
              label: 'Model',
              available: true,
              reasoningCapabilities: { providerDefault: true, levels: ['low', 'medium', 'high'] },
            },
          ]}
          value={{
            modelProfile: 'model',
            ...(fixed ? { reasoning: { mode: 'fixed' as const, level: 'high' as const } } : {}),
          }}
          showReasoning
          disabled={false}
          open
          onOpenChange={vi.fn()}
          onChange={vi.fn()}
        />
      </DesignKitProvider>
    </IntlProvider>,
  );
}

it('uses one policy setting row and the kit horizontal effort tabs for a fixed level', () => {
  show(true);
  const panel = screen.getByRole('dialog');
  expect(within(panel).getByRole('combobox', { name: 'Reasoning effort' })).toBeInTheDocument();
  const efforts = within(panel).getByRole('tablist', { name: 'Effort' });
  expect(within(efforts).getByRole('tab', { name: 'High' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(within(panel).queryByRole('radiogroup')).toBeNull();
  expect(within(panel).queryByRole('switch')).toBeNull();
});

it('keeps unset as its own policy without showing fixed-effort controls or pretending it is off', () => {
  show(false);
  expect(screen.getByRole('combobox', { name: 'Reasoning effort' })).toHaveTextContent('Default');
  expect(screen.queryByRole('tablist')).toBeNull();
  expect(screen.queryByRole('switch')).toBeNull();
});

it('labels an empty simulated picker without replacing a saved missing model value', () => {
  const { rerender } = render(
    <DesignKitProvider>
      <ModelPicker
        models={[]}
        value=""
        open
        reasoning={null}
        placeholder="Simulation"
        labels={{ empty: 'No connected models in this demo' }}
      />
    </DesignKitProvider>,
  );
  expect(screen.getByRole('button', { name: 'Model: Simulation' })).toHaveTextContent('Simulation');
  expect(screen.getByText('No connected models in this demo')).toBeInTheDocument();
  expect(screen.queryByRole('option')).toBeNull();
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByRole('switch')).toBeNull();
  rerender(
    <DesignKitProvider>
      <ModelPicker models={[]} value="saved-profile" reasoning={null} placeholder="Simulation" />
    </DesignKitProvider>,
  );
  expect(screen.getByRole('button', { name: 'Model: saved-profile' })).toHaveTextContent(
    'saved-profile',
  );
});
