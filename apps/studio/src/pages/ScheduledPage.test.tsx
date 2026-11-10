// @vitest-environment jsdom
import type { Schedule, ScheduleDraft, ScheduledOccurrence } from '@corral/contracts';
import type { RunSummary } from '@corral/core';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ScheduledPage } from './ScheduledPage.tsx';

const fixture = vi.hoisted(() => {
  const api = {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    history: vi.fn(),
    run: vi.fn(),
  };
  const services = {
    mode: 'server',
    live: false,
    repository: {
      listProjects: vi.fn(async () => [{ projectId: 'project_1', name: 'My project' }]),
      listSessions: vi.fn(async () => [
        { sessionId: 'session_1', projectId: 'project_1', title: 'Daily notes', entries: [] },
      ]),
      getSession: vi.fn(),
    },
    models: { profiles: vi.fn(async () => [{ profileId: 'model-a' }]) },
    transport: { listRuns: vi.fn(), sendCommand: vi.fn() },
    cancelAuto: vi.fn(),
  };
  return { api, services };
});
vi.mock('../schedules-api.ts', () => ({ schedulesApi: fixture.api }));
vi.mock('../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to: _to,
    params: _params,
    search,
    ...props
  }: {
    children?: ReactNode;
    to?: string;
    params?: unknown;
    search?: unknown;
  }) => (
    <a href="#run" data-search={JSON.stringify(search ?? {})} {...props}>
      {children}
    </a>
  ),
}));

const schedule = (change: Partial<Schedule> = {}): Schedule => ({
  id: 'schedule_1',
  revision: 2,
  title: 'Daily project review',
  hostId: 'local',
  projectId: 'project_1',
  sessionId: 'session_1',
  timezone: 'UTC',
  rule: { kind: 'daily', time: '09:00' },
  enabled: true,
  request: {
    brief: 'Summarize the available information.',
    choice: { modelProfile: 'model-a' },
    mode: 'mock',
    permissionMode: 'ask',
    configRevision: 2,
  },
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  nextAt: '2026-11-11T09:00:00.000Z',
  deletedAt: null,
  ...change,
});
const started = (change: Partial<ScheduledOccurrence> = {}): ScheduledOccurrence => ({
  id: 'occurrence_1',
  scheduleId: 'schedule_1',
  revision: 2,
  dueAt: '2026-11-10T09:00:00.000Z',
  commandId: 'scheduled_1',
  manual: false,
  status: 'started',
  runId: 'run_1',
  detail: null,
  createdAt: '2026-11-10T09:00:00.000Z',
  ...change,
});
const run = (status: RunSummary['status']) =>
  ({
    runId: 'run_1',
    sessionId: 'session_1',
    status,
    startedAt: '2026-11-10T09:00:01.000Z',
  }) as RunSummary;

let container: HTMLElement;
let dispose: () => Promise<void>;
beforeEach(() => {
  for (const mock of Object.values(fixture.api)) mock.mockReset();
  fixture.services.transport.listRuns.mockReset();
  fixture.services.transport.sendCommand.mockReset();
  fixture.services.cancelAuto.mockReset();
  fixture.services.mode = 'server';
  fixture.services.repository.getSession.mockReset();
  fixture.services.repository.getSession.mockImplementation(async (sessionId: string) => ({
    sessionId,
    projectId: 'project_1',
    title: 'Daily notes',
  }));
  fixture.api.list.mockResolvedValue({ schedules: [] });
  fixture.api.history.mockResolvedValue({ occurrences: [] });
  fixture.services.transport.listRuns.mockResolvedValue([]);
});
afterEach(async () => {
  await dispose?.();
  vi.unstubAllGlobals();
});

async function page() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  dispose = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  await act(async () => {
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ScheduledPage />
      </IntlProvider>,
    );
  });
  await settle();
}
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const button = (name: string | RegExp) => {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => {
    const label = item.getAttribute('aria-label') ?? item.textContent?.trim() ?? '';
    return typeof name === 'string' ? label === name : name.test(label);
  });
  if (!found) throw new Error(`no button ${name}`);
  return found;
};
const click = (element: HTMLElement) => act(async () => element.click());
const field = (label: string) => {
  const found = [...container.querySelectorAll('label')].find((item) =>
    item.textContent?.startsWith(label),
  );
  const control = found?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
  if (!control) throw new Error(`no field ${label}`);
  return control;
};
const type = (control: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(async () => {
    const prototype =
      control instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
const history = () => container.querySelector<HTMLElement>('section[aria-label="Run history"]');
const toggle = (name: string) => {
  const found = [...container.querySelectorAll<HTMLElement>('[role="switch"]')].find(
    (item) =>
      document.getElementById(item.getAttribute('aria-labelledby') ?? '')?.textContent === name,
  );
  if (!found) throw new Error(`no switch ${name}`);
  return found;
};

it('lists each schedule with its timing, state and last result', async () => {
  fixture.api.list.mockResolvedValue({
    schedules: [
      schedule(),
      schedule({
        id: 'schedule_2',
        title: 'Weekly digest',
        enabled: false,
        rule: { kind: 'weekly', time: '18:30', weekdays: [1, 3] },
      }),
    ],
  });
  fixture.api.history.mockImplementation(async (id: string) => ({
    occurrences: id === 'schedule_1' ? [started()] : [],
  }));
  fixture.services.transport.listRuns.mockResolvedValue([run('succeeded')]);
  await page();
  const rows = [...container.querySelectorAll('tbody tr')].map((row) =>
    [...row.querySelectorAll('td')].map((cell) => cell.textContent?.trim()),
  );
  expect(rows).toEqual([
    [
      'Daily project review',
      'Every day at 09:00',
      'Enabled',
      expect.stringContaining('Nov 11'),
      'Succeeded',
    ],
    ['Weekly digest', 'Mon, Wed at 18:30', 'Disabled', 'No upcoming run', 'Not run yet'],
  ]);
});

it('a refresh tick reads only the shown schedule’s history; opening, focus and actions read all', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    const ids = ['schedule_1', 'schedule_2', 'schedule_3', 'schedule_4', 'schedule_5'];
    fixture.api.list.mockResolvedValue({
      schedules: ids.map((id, index) => schedule({ id, title: `Schedule ${index + 1}` })),
    });
    fixture.api.update.mockImplementation(async (current: Schedule, draft: ScheduleDraft) =>
      schedule({ ...current, ...draft, revision: current.revision + 1 }),
    );
    const read = () => fixture.api.history.mock.calls.map(([id]) => id).sort();
    await page();
    expect(read()).toEqual(ids);
    await click(button('Schedule 3'));
    fixture.api.history.mockClear();
    fixture.api.list.mockClear();
    fixture.services.transport.listRuns.mockClear();
    // Runs are read only by the shared run list, at its own 1.5 s step; the schedule's 3 s tick
    // reads the list and the shown history, and adds no run read of its own.
    await act(async () => vi.advanceTimersByTime(1500));
    await settle();
    expect(fixture.services.transport.listRuns).toHaveBeenCalledTimes(1);
    expect(fixture.api.list).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1500));
    await settle();
    expect(fixture.api.list).toHaveBeenCalledTimes(1);
    expect(fixture.services.transport.listRuns).toHaveBeenCalledTimes(2);
    expect(read()).toEqual(['schedule_3']);
    fixture.api.history.mockClear();
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();
    expect(read()).toEqual(ids);
    fixture.api.history.mockClear();
    await click(toggle('Enable scheduled runs'));
    await settle();
    expect(fixture.api.update).toHaveBeenCalledTimes(1);
    expect(read()).toEqual(ids);
  } finally {
    vi.useRealTimers();
  }
});

it('saves a new schedule disabled and says it will not run until enabled', async () => {
  fixture.api.create.mockImplementation(async (draft: ScheduleDraft) =>
    schedule({ ...draft, id: 'schedule_new', revision: 1 }),
  );
  await page();
  await click(button('New schedule'));
  expect(toggle('Enable scheduled runs').getAttribute('aria-checked')).toBe('false');
  await type(field('Title'), 'Daily project review');
  await type(field('Request'), 'Summarize the available information.');
  await click(button('Save schedule'));
  await settle();
  expect(fixture.api.create).toHaveBeenCalledTimes(1);
  expect(fixture.api.create.mock.calls[0]?.[0]).toMatchObject({
    title: 'Daily project review',
    enabled: false,
    sessionId: 'session_1',
  });
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    'Saved as disabled. This schedule will not run until you enable it.',
  );
});

it('keeps a run status unknown when the run cannot be read, never completed', async () => {
  fixture.api.list.mockResolvedValue({ schedules: [schedule()] });
  fixture.api.history.mockResolvedValue({ occurrences: [started()] });
  fixture.services.transport.listRuns.mockRejectedValue(new Error('offline'));
  await page();
  await click(button(/Daily project review/));
  const records = history();
  expect(records?.textContent).toContain('Started');
  expect(records?.textContent).toContain('Status unknown');
  expect(records?.textContent).not.toMatch(/Succeeded|Completed/);
  // Not known to wait for the person: the link only opens the run.
  expect(records?.querySelector('a')?.textContent).toBe('Open run');
  // A listing without that run is no better: still unknown.
  fixture.services.transport.listRuns.mockResolvedValue([
    { ...run('succeeded'), runId: 'run_other' },
  ]);
  await act(async () => window.dispatchEvent(new Event('focus')));
  await settle();
  expect(history()?.textContent).toContain('Status unknown');
  expect(history()?.textContent).not.toContain('Succeeded');
});

it('a run waiting for the person is a link to respond; any other run is a link to open it', async () => {
  fixture.api.list.mockResolvedValue({ schedules: [schedule()] });
  fixture.api.history.mockResolvedValue({ occurrences: [started()] });
  fixture.services.transport.listRuns.mockResolvedValue([run('awaiting_user')]);
  await page();
  await click(button(/Daily project review/));
  const link = () => history()?.querySelector('a');
  expect(link()?.textContent).toBe('Respond');
  expect(JSON.parse(link()?.getAttribute('data-search') ?? '{}')).toEqual({
    panel: 'run',
    view: 'run',
    run: 'run_1',
    respond: true,
  });
  // Once it moves on, the same row opens the run.
  fixture.services.transport.listRuns.mockResolvedValue([run('running')]);
  await act(async () => window.dispatchEvent(new Event('focus')));
  await settle();
  expect(link()?.textContent).toBe('Open run');
  expect(JSON.parse(link()?.getAttribute('data-search') ?? '{}')).toEqual({
    panel: 'run',
    view: 'run',
    run: 'run_1',
  });
  // The column is named for what its links do.
  expect(history()?.querySelector('thead')?.textContent).toContain('Open run');
});

it('disabling stops future runs without cancelling the one in progress', async () => {
  fixture.api.list.mockResolvedValue({ schedules: [schedule()] });
  fixture.api.history.mockResolvedValue({ occurrences: [started()] });
  fixture.services.transport.listRuns.mockResolvedValue([run('running')]);
  fixture.api.update.mockImplementation(async (current: Schedule, draft: ScheduleDraft) =>
    schedule({ ...draft, revision: current.revision + 1, nextAt: null }),
  );
  await page();
  await click(button(/Daily project review/));
  await click(toggle('Enable scheduled runs'));
  await settle();
  expect(fixture.api.update).toHaveBeenCalledTimes(1);
  expect(fixture.api.update.mock.calls[0]?.[0]).toMatchObject({ id: 'schedule_1', revision: 2 });
  expect(fixture.api.update.mock.calls[0]?.[1]).toMatchObject({ enabled: false });
  expect(fixture.api.remove).not.toHaveBeenCalled();
  expect(fixture.api.run).not.toHaveBeenCalled();
  expect(fixture.services.transport.sendCommand).not.toHaveBeenCalled();
  expect(fixture.services.cancelAuto).not.toHaveBeenCalled();
  expect(history()?.textContent).toContain('Running');
});

it('Run now asks once for a double click and keeps its command ID for a retry', async () => {
  fixture.api.list.mockResolvedValue({ schedules: [schedule()] });
  let fail: (error: Error) => void = () => {};
  fixture.api.run.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));
  // The server's history holds the firing from then on, as the reads after the action see it.
  fixture.api.run.mockImplementationOnce(async () => {
    fixture.api.history.mockResolvedValue({ occurrences: [started({ manual: true })] });
    return { occurrences: [started({ manual: true })] };
  });
  await page();
  await click(button(/Daily project review/));
  const runNow = button('Run now');
  await act(async () => {
    runNow.click();
    runNow.click();
  });
  expect(fixture.api.run).toHaveBeenCalledTimes(1);
  await act(async () => fail(new Error('The response was lost.')));
  await settle();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('The response was lost.');
  await click(button('Run now'));
  await settle();
  expect(fixture.api.run).toHaveBeenCalledTimes(2);
  const [first, second] = fixture.api.run.mock.calls;
  expect(first?.[1]).toMatch(/^manual_/);
  expect(second?.[1]).toBe(first?.[1]);
  expect(history()?.textContent).toContain('Started');
  // The firing is marked as a manual one, not with the name of the action that made it.
  const due = history()?.querySelector('tbody td');
  expect(due?.textContent).toContain(`AM · ${messages.Schedules.manual}`);
  expect(due?.textContent).not.toContain('Run now');
});

it('a run that settles updates its history row with the shared run list, not a later tick', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    fixture.api.list.mockResolvedValue({ schedules: [schedule()] });
    fixture.api.history.mockResolvedValue({ occurrences: [started({ manual: true })] });
    fixture.services.transport.listRuns.mockResolvedValue([run('running')]);
    await page();
    await click(button(/Daily project review/));
    await settle();
    expect(history()?.textContent).toContain('Running');
    // The run settles. The run list the sidebar and its notice read sees it at its next step,
    // before the schedule's own refresh tick comes round.
    fixture.services.transport.listRuns.mockResolvedValue([run('succeeded')]);
    await act(async () => vi.advanceTimersByTime(1500));
    await settle();
    expect(history()?.textContent).toContain('Succeeded');
    expect(history()?.textContent).not.toContain('Running');
  } finally {
    vi.useRealTimers();
  }
});

/** The detail's Target value. */
const target = () => {
  const term = [...container.querySelectorAll('dt')].find((item) => item.textContent === 'Target');
  return term?.nextElementSibling as HTMLElement | null | undefined;
};

it('names the target session by its current title, as it is after Run now, and links to it', async () => {
  fixture.api.list.mockResolvedValue({ schedules: [schedule()] });
  // The session was listed as new when the page opened; its first run gives it a title.
  fixture.services.repository.getSession.mockResolvedValue({
    sessionId: 'session_1',
    projectId: 'project_1',
    title: 'New session',
  });
  await page();
  await click(button(/Daily project review/));
  await settle();
  expect(target()?.querySelector('a')?.textContent).toBe('New session');
  fixture.api.run.mockImplementationOnce(async () => {
    fixture.services.repository.getSession.mockResolvedValue({
      sessionId: 'session_1',
      projectId: 'project_1',
      title: 'Summarize the README',
    });
    fixture.api.history.mockResolvedValue({ occurrences: [started({ manual: true })] });
    return { occurrences: [started({ manual: true })] };
  });
  await click(button('Run now'));
  await settle();
  expect(target()?.textContent).toContain('My project');
  expect(target()?.querySelector('a')?.textContent).toBe('Summarize the README');
  expect(target()?.textContent).not.toContain('New session');
});

it('says plainly when the target session cannot be found, without a link', async () => {
  fixture.api.list.mockResolvedValue({ schedules: [schedule({ sessionId: 'session_gone' })] });
  fixture.services.repository.getSession.mockResolvedValue(null);
  await page();
  await click(button(/Daily project review/));
  await settle();
  expect(target()?.textContent).toContain('Session not found');
  expect(target()?.querySelector('a')).toBeNull();
});

it('in the browser demo, the empty state gives the reason and there is no disabled New schedule', async () => {
  fixture.services.mode = 'browser';
  await page();
  // One condition, said once: the empty state's title is the reason, as in Library resources.
  const empty = container.querySelector<HTMLElement>('.border-dashed');
  expect(empty?.querySelector('b')?.textContent).toBe(messages.Schedules.localOnly);
  expect(container.textContent).not.toContain('No schedules');
  expect(empty?.querySelector('p')?.textContent).toBe(messages.Schedules.localOnlyText);
  expect(
    [...container.querySelectorAll('button')].some((item) => item.textContent === 'New schedule'),
  ).toBe(false);
});
