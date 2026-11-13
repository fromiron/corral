// @vitest-environment jsdom
import { act, type ComponentProps, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ScheduledRunNotifications } from './ScheduledRunNotifications.tsx';
import { automationShownRuns, type ScheduledRunOutcome } from './scheduledRuns.ts';

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
  automationShownRuns.setState({ runIds: [] });
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
  expect(container.textContent).toContain('Scheduled run: Completed');
  expect(dismiss).not.toHaveBeenCalled();
});

it('says nothing on Automation, where the schedule’s row and history show the result', async () => {
  fixture.pathname = '/schedules';
  automationShownRuns.setState({ runIds: ['run_1'] });
  const dismiss = await show();
  expect(container.textContent).not.toContain('Scheduled run');
  // Seen there, it does not come back as a banner on the next screen.
  expect(dismiss).toHaveBeenCalledWith('run_1');
});

/** The banners as RootLayout holds them: a dismissed result leaves the list. */
function Banners({ initial }: { initial: ScheduledRunOutcome[] }) {
  const [shown, setShown] = useState(initial);
  return (
    <ScheduledRunNotifications
      results={shown}
      dismiss={(runId) => setShown((current) => current.filter((run) => run.runId !== runId))}
    />
  );
}

it('on Automation dismisses only the results the page showed; the rest wait for the next screen', async () => {
  fixture.pathname = '/schedules';
  const both: ScheduledRunOutcome[] = [
    { runId: 'run_1', sessionId: 'session_1', status: 'succeeded' },
    // Its schedule was deleted, or the page's read failed: Automation never showed it.
    { runId: 'run_2', sessionId: 'session_1', status: 'failed' },
  ];
  const render = () =>
    act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <Banners initial={both} />
        </IntlProvider>,
      ),
    );
  await render();
  expect(container.textContent).toBe('');
  // The page shows run_1's final status: only that one is dismissed.
  await act(async () => automationShownRuns.setState({ runIds: ['run_1'] }));
  expect(container.textContent).toBe('');
  // Leaving Automation, the page no longer shows anything, and run_2's banner appears.
  fixture.pathname = '/projects/alpha';
  await act(async () => automationShownRuns.setState({ runIds: [] }));
  await render();
  const banners = [...container.querySelectorAll('[role="note"]')].map((note) => note.textContent);
  expect(banners).toEqual([expect.stringContaining('Scheduled run: Failed')]);
});
