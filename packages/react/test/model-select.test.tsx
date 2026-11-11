import { render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { ModelSelect, profileChoices } from '../src/components/ModelSelect.tsx';
import { DesignKitProvider, type ModelOption } from '../src/design-kit/index.ts';
import messages from '../src/messages/en.json' with { type: 'json' };

function Field(props: Partial<Parameters<typeof ModelSelect>[0]> & { options: ModelOption[] }) {
  return (
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <DesignKitProvider>
        <ModelSelect label="Model of writer" value="" onValueChange={vi.fn()} {...props} />
      </DesignKitProvider>
    </IntlProvider>
  );
}
const trigger = () => document.querySelector<HTMLElement>('[data-slot="model-picker-trigger"]');

describe('model field', () => {
  it('keeps a saved value that is no longer listed, named and described, but not choosable', async () => {
    render(
      <Field
        value="old-profile"
        open
        options={[{ id: 'gpt-6', name: 'GPT-6', description: '', group: 'OpenAI' }]}
      />,
    );
    expect(trigger()).toHaveAttribute('aria-label', 'Model of writer: old-profile');
    expect(trigger()?.getAttribute('aria-description')).toContain('Unavailable profile');
    const missing = await screen.findByRole('option', { name: /old-profile/ });
    expect(missing).toHaveAttribute('aria-disabled', 'true');
    expect(missing).toHaveAttribute('aria-label', 'old-profile, Unavailable profile');
  });

  it('says an unavailable current value in the trigger’s description, not only in its text', () => {
    render(
      <Field
        value="openai:gpt-6"
        options={[
          {
            id: 'openai:gpt-6',
            name: 'GPT-6',
            description: 'Not connected',
            disabled: true,
            group: 'OpenAI',
          },
        ]}
      />,
    );
    expect(trigger()).toHaveAttribute('aria-label', 'Model of writer: GPT-6');
    expect(trigger()?.getAttribute('aria-description')).toContain('Not connected');
  });

  it('marks a model confirmed to take images, with a name and no words on the row', async () => {
    const options = profileChoices(
      [
        {
          profileId: 'openai:gpt-6',
          source: 'connection',
          provider: 'openai',
          providerName: 'OpenAI',
          modelId: 'gpt-6',
          modelName: 'GPT-6',
          label: 'OpenAI · GPT-6',
          available: true,
          imageInput: true,
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
          imageInput: false,
        },
        {
          profileId: 'openai:o8',
          source: 'connection',
          provider: 'openai',
          providerName: 'OpenAI',
          modelId: 'o8',
          modelName: 'o8',
          label: 'OpenAI · o8',
          available: true,
          imageInput: null,
        },
      ],
      { profiles: 'Profiles', unavailable: 'Not connected' },
    );
    render(<Field open options={options} />);
    const list = await screen.findByRole('listbox');
    const row = (name: string) =>
      within(list).getByRole('option', { name: new RegExp(`^${name}`) });
    expect(row('GPT-6')).toHaveAttribute('aria-label', 'GPT-6, Image input');
    expect(row('GPT-6').querySelector('[data-mark="image"]')).not.toBeNull();
    expect(row('GPT-6').textContent).toBe('GPT-6');
    // Text only and unknown alike show nothing.
    for (const name of ['o9', 'o8']) {
      expect(row(name)).toHaveAttribute('aria-label', name);
      expect(row(name).querySelector('[data-mark="image"]')).toBeNull();
    }
  });
});
