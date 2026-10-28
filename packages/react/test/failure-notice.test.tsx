import { render, screen } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { expect, it } from 'vitest';
import { FailureNotice } from '../src/components/FailureNotice.tsx';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };

it.each(['en', 'ko'] as const)(
  'explains cancellation before collapsed diagnostics (%s)',
  (locale) => {
    const { container } = render(
      <IntlProvider locale={locale} messages={locale === 'en' ? en : ko}>
        <FailureNotice message="TARGET_TERMINAL: scope cancelled" cancelled />
      </IntlProvider>,
    );
    expect(
      screen.getByText(locale === 'en' ? 'This step was cancelled.' : '이 단계는 취소되었습니다.'),
    ).toBeVisible();
    expect(container.querySelector('details')).not.toHaveAttribute('open');
    expect(container.querySelector('details code')).toHaveTextContent(
      'TARGET_TERMINAL: scope cancelled',
    );
  },
);

it('shows a safe missing-target reason from the recorded code', () => {
  render(
    <IntlProvider locale="en" messages={en}>
      <FailureNotice code="TARGET_NOT_FOUND" message="the folder is unavailable" />
    </IntlProvider>,
  );
  expect(screen.getByText('The requested file, folder, or target is unavailable.')).toBeVisible();
});

it('explains the legacy scope-cancelled settlement without showing its code by default', () => {
  render(
    <IntlProvider locale="en" messages={en}>
      <FailureNotice message="TARGET_TERMINAL: scope cancelled" />
    </IntlProvider>,
  );
  expect(
    screen.getByText(
      'The target has ended or was cancelled, so this request could not be applied.',
    ),
  ).toBeVisible();
});
