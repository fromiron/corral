// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ScheduledRunNotifications } from './ScheduledRunNotifications.tsx';

const fixture = vi.hoisted(() => ({ pathname: '/projects/alpha' }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, ...props }: ComponentProps<'a'> & { to: string }) => <a {...props} href={to} />,
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string } }) => unknown;
  }) => select({ location: { pathname: fixture.pathname } }),
}));

const results = [{ runId: 'run_1', sessionId: 'session_1', status: 'succeeded' as const }];
let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function show(dismiss = vi.fn()) {
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ScheduledRunNotifications results={results} dismiss={dismiss} />
      </IntlProvider>,
    ),
  );
  return dismiss;
}

it('tells of a finished scheduled run away from Automation', async () => {
  fixture.pathname = '/projects/alpha';
  const dismiss = await show();
  expect(container.textContent).toContain('Scheduled run: Succeeded');
  expect(dismiss).not.toHaveBeenCalled();
});

it('says nothing on Automation, where the schedule’s row and history show the result', async () => {
  fixture.pathname = '/schedules';
  const dismiss = await show();
  expect(container.textContent).not.toContain('Scheduled run');
  // Seen there, it does not come back as a banner on the next screen.
  expect(dismiss).toHaveBeenCalledWith('run_1');
});
