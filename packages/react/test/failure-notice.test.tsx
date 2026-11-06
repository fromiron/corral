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

it.each([
  ['HTTP 401 (AUTH)', 'The model provider rejected the credentials.'],
  ['HTTP 429 (RATE_LIMIT)', 'The model provider is limiting requests.'],
  ['HTTP 503 (SERVER)', 'The model provider is temporarily unavailable.'],
  ['TRANSPORT', 'The model provider could not be reached.'],
])('explains the sanitized provider failure %s without requiring diagnostics', (reason, label) => {
  render(
    <IntlProvider locale="en" messages={en}>
      <FailureNotice message={`the model request failed: ${reason}`} />
    </IntlProvider>,
  );
  expect(screen.getByText(label)).toBeVisible();
});

it('keeps a Korean recovery action visible while retaining the safe diagnostic in a fold', () => {
  const { container } = render(
    <IntlProvider locale="ko" messages={ko}>
      <FailureNotice message="the model request failed: HTTP 401 (AUTH)" />
    </IntlProvider>,
  );
  expect(screen.getByText('모델 제공자가 인증 정보를 거부했어요.')).toBeVisible();
  expect(
    screen.getByText('설정 → 모델에서 다시 연결하거나 API 키를 바꾼 뒤 재시도하세요.'),
  ).toBeVisible();
  expect(container.querySelector('details')).not.toHaveAttribute('open');
});

it('does not treat arbitrary diagnostic text as a trusted provider classification', () => {
  render(
    <IntlProvider locale="en" messages={en}>
      <FailureNotice message="raw response AUTH HTTP 401" />
    </IntlProvider>,
  );
  expect(screen.getByText(en.Failure.unknown)).toBeVisible();
});
