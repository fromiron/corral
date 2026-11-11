import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { AutoModelMenu } from '../../../apps/studio/src/workbench/AutoModelMenu.tsx';
import type { ProfileInfo } from '../../../apps/studio/src/workbench/useModels.ts';
import { DesignKitProvider, type ModelOption, ModelPicker } from '../src/design-kit/index.ts';
import messages from '../src/messages/en.json' with { type: 'json' };

const search = { label: 'Search models', noMatch: (query: string) => `No model matches ${query}` };

function many(count: number): ModelOption[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i % 6}:model-${i}`,
    name: `Model ${String(i).padStart(3, '0')}`,
    description: '',
    group: `Provider ${i % 6}`,
    keywords: `model-${i}`,
  })).sort((a, b) => (a.group ?? '').localeCompare(b.group ?? ''));
}

function Picker(props: Partial<Parameters<typeof ModelPicker>[0]>) {
  return (
    <DesignKitProvider>
      <ModelPicker models={[]} reasoning={null} search={search} {...props} />
    </DesignKitProvider>
  );
}

describe('model picker search and groups', () => {
  it('focuses the search, filters by name, id and provider, and keeps the groups named', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Picker
        defaultOpen
        value="openai:gpt-6"
        onValueChange={onValueChange}
        models={[
          { id: 'model-a', name: 'GPT-6', description: 'model-a', group: 'Profiles' },
          {
            id: 'openai:gpt-6',
            name: 'GPT-6',
            description: '',
            group: 'OpenAI',
            keywords: 'gpt-6',
          },
          {
            id: 'openai:o9',
            name: 'o9 mini',
            description: '',
            group: 'OpenAI',
            keywords: 'o9-mini',
          },
          {
            id: 'copilot:claude',
            name: 'Claude Opus',
            description: '',
            group: 'GitHub Copilot',
            keywords: 'claude-opus',
          },
        ]}
      />,
    );
    const field = await screen.findByRole('combobox', { name: 'Search models' });
    await waitFor(() => expect(field).toHaveFocus());
    const list = screen.getByRole('listbox');
    expect(
      within(list)
        .getAllByRole('group')
        .map((g) => g.getAttribute('aria-label')),
    ).toEqual(['Profiles', 'OpenAI', 'GitHub Copilot']);
    // The selection is the active row on open.
    expect(field.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'GPT-6', selected: true }).id,
    );

    await user.type(field, 'o9-mini');
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual([
      'o9 mini',
    ]);
    await user.clear(field);
    await user.type(field, 'copilot');
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual([
      'Claude Opus',
    ]);
    await user.clear(field);
    await user.type(field, 'nothing like it');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No model matches nothing like it')).toBeInTheDocument();

    await user.clear(field);
    await user.type(field, 'gpt');
    // The first match is active; arrows move through the results and Enter picks.
    const options = () => screen.getAllByRole('option');
    expect(field.getAttribute('aria-activedescendant')).toBe(options()[0]?.id);
    await user.keyboard('{ArrowDown}');
    expect(field.getAttribute('aria-activedescendant')).toBe(options()[1]?.id);
    await user.keyboard('{Enter}');
    expect(onValueChange).toHaveBeenLastCalledWith('openai:gpt-6');
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(
      <Picker
        value="a"
        models={[
          { id: 'a', name: 'A', description: '', group: 'One' },
          { id: 'b', name: 'B', description: '', group: 'One' },
        ]}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Model: A' });
    await user.click(trigger);
    const field = await screen.findByRole('combobox', { name: 'Search models' });
    await waitFor(() => expect(field).toHaveFocus());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('draws only the rows near the visible part of a long list and keeps the choice in view', async () => {
    const user = userEvent.setup();
    const models = many(600);
    const chosen = models[590] as ModelOption;
    render(<Picker defaultOpen value={chosen.id} models={models} />);
    const field = await screen.findByRole('combobox', { name: 'Search models' });
    const drawn = screen.getAllByRole('option');
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan(60);
    // The current choice is drawn (scrolled to) on open.
    const current = screen.getByRole('option', { selected: true });
    expect(current).toHaveAttribute('aria-label', chosen.name);
    expect(screen.getByRole('listbox').scrollTop).toBeGreaterThan(0);
    // A model far down the list is found by typing.
    await user.type(field, 'model-3');
    expect(screen.getAllByRole('option').length).toBeLessThan(60);
    await user.clear(field);
    await user.type(field, 'model-17');
    expect(screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(
      expect.arrayContaining(['Model 017', 'Model 170']),
    );
    // End reaches the last result and draws it.
    await user.clear(field);
    await user.keyboard('{End}');
    const last = models.at(-1) as ModelOption;
    await waitFor(() =>
      expect(field.getAttribute('aria-activedescendant')).toBe(
        screen.getByRole('option', { name: last.name }).id,
      ),
    );
    act(() => {
      fireEvent.scroll(screen.getByRole('listbox'), { target: { scrollTop: 0 } });
    });
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-label', models[0]?.name);
  });
});

describe('composer picker groups', () => {
  const profiles: ProfileInfo[] = [
    {
      profileId: 'model-a',
      source: 'profile',
      provider: 'openai',
      providerName: 'OpenAI',
      modelId: 'gpt-6-luna',
      modelName: 'GPT-6 Luna',
      label: 'OpenAI · GPT-6 Luna',
      available: true,
    },
    {
      profileId: 'gpt-6-sol',
      source: 'profile',
      provider: 'openai',
      providerName: 'OpenAI',
      modelId: 'gpt-6-sol',
      modelName: 'GPT-6 Sol',
      label: 'OpenAI · GPT-6 Sol',
      available: true,
    },
    {
      profileId: 'openai:o9',
      source: 'connection',
      provider: 'openai',
      providerName: 'OpenAI',
      modelId: 'o9',
      modelName: 'o9',
      label: 'OpenAI · o9',
      available: true,
    },
    {
      profileId: 'github-copilot:claude-opus',
      source: 'connection',
      provider: 'github-copilot',
      providerName: 'GitHub Copilot',
      modelId: 'claude-opus',
      modelName: 'Claude Opus',
      label: 'GitHub Copilot · Claude Opus',
      available: true,
    },
  ];

  it('lists named profiles first, then one group per provider, each model once', async () => {
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <DesignKitProvider>
          <AutoModelMenu
            value={{ modelProfile: 'model-a' }}
            profiles={profiles}
            showReasoning={false}
            disabled={false}
            open
            onOpenChange={vi.fn()}
            onChange={vi.fn()}
          />
        </DesignKitProvider>
      </IntlProvider>,
    );
    expect(await screen.findByRole('combobox', { name: 'Search models' })).toBeInTheDocument();
    const groups = within(screen.getByRole('listbox')).getAllByRole('group');
    // Providers in alphabetical order after the profiles.
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      'Profiles',
      'GitHub Copilot',
      'OpenAI',
    ]);
    // A row is the model's name; the profile's name shows only when it differs from the model id.
    expect(
      within(groups[0] as HTMLElement)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['GPT-6 Lunamodel-a', 'GPT-6 Sol']);
    expect(
      within(groups[2]!)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['o9']);
    expect(screen.getAllByRole('option', { name: /GPT-6 Luna/ })).toHaveLength(1);
  });
});
