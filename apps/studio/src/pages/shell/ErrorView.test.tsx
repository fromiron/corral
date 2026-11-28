// @vitest-environment jsdom
import { ApiError } from '@corral/client';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ErrorView } from './RootLayout.tsx';

vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  Link: ({ children }: { children?: ReactNode }) => <a href="/">{children}</a>,
  useRouter: () => ({ invalidate: async () => {} }),
}));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0)) await undo();
  vi.unstubAllGlobals();
});

async function show(error: unknown) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages}>
        <ErrorView error={error as Error} reset={() => {}} />
      </IntlProvider>,
    ),
  );
  return container.querySelector('[role="alert"] h2')?.textContent;
}

it('says a refusal for too many requests in its own words, not the server’s', async () => {
  expect(await show(new ApiError(429, 'LIMIT_REACHED', 'local request rate exceeded'))).toBe(
    messages.Studio.tooManyRequests,
  );
});

it('keeps the server’s reason for any other failure', async () => {
  expect(await show(new ApiError(500, 'UNKNOWN', 'disk is full'))).toBe(
    messages.Studio.error.replace('{message}', 'disk is full'),
  );
  expect(await show(new ApiError(409, 'LIMIT_REACHED', 'the queue is full'))).toBe(
    messages.Studio.error.replace('{message}', 'the queue is full'),
  );
});
