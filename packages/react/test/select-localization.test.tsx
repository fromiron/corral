import { render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { expect, it } from 'vitest';
import { Select } from '../src/design-kit/adapters/select.tsx';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };

it.each([
  ['en', en, 'Select…'],
  ['ko', ko, '선택…'],
] as const)(
  'localizes an empty Select in %s and preserves an explicit placeholder',
  (locale, messages, placeholder) => {
    const view = (custom?: string) => (
      <IntlProvider locale={locale} messages={messages}>
        <Select
          label="Project default"
          value={null}
          options={[]}
          onValueChange={() => {}}
          placeholder={custom}
        />
      </IntlProvider>
    );
    const { rerender } = render(view());
    expect(screen.getByRole('combobox', { name: 'Project default' })).toHaveTextContent(
      placeholder,
    );
    rerender(view('Choose a work style'));
    expect(screen.getByRole('combobox', { name: 'Project default' })).toHaveTextContent(
      'Choose a work style',
    );
  },
);
