// @vitest-environment jsdom
import type { RunProjection } from '@corral/core';
import { AdviceSeenProvider, type RunSessionStore } from '@corral/react';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useStore } from 'zustand';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import ko from '../../../../packages/react/src/messages/ko.json' with { type: 'json' };
import {
  ADVISOR_RUN,
  advisorRunSession,
  endedRun,
  withAdvice,
} from '../../../../packages/react/src/stories/advisorRunFixture.ts';
import { AdviceArrival, type AdviceArrivalValue } from './adviceArrival.ts';
import { changePreferences, parsePreferences, preferences } from './preferences.ts';
import { RunMessage } from './RunMessage.tsx';

// An advisor's advice in the conversation (docs/specs/features/advisor.md 보이는 곳): a line in
// its target's work, and advice its target never read written into the run row's tail line, so an
// ended row keeps its height (composer-flow.md "튐 없는 본문" rule 3). Seeing those words in full
// is what clears them from Needs you (features/inbox.md `advice`).

const fixture = vi.hoisted(() => ({ store: null as RunSessionStore | null }));
vi.mock('./useCorralChat.ts', () => ({
  useCorralRun: () => ({
    store: fixture.store,
    state: useStore(fixture.store as RunSessionStore),
    conversationTurn: null,
    bodyMetadataCurrent: true,
  }),
}));
vi.mock('../pages/Workbench.tsx', () => ({
  useRemembered: (_key: string, initial: boolean) => useState(initial),
}));
vi.mock('../pages/GettingStarted.tsx', () => ({ markRunReviewed() {} }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a href="#link">{children}</a>,
}));

const cleanup: (() => void)[] = [];
const observed: { element: Element; callback: IntersectionObserverCallback }[] = [];
Element.prototype.getAnimations ??= () => [];
beforeEach(() => {
  observed.length = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback;
      }
      observe(element: Element) {
        observed.push({ element, callback: this.callback });
      }
      disconnect() {
        const at = observed.findIndex((entry) => entry.callback === this.callback);
        if (at >= 0) observed.splice(at, 1);
      }
      unobserve() {}
    },
  );
  changePreferences({ chatDensity: 'basic' });
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) act(dispose);
  preferences.setState(parsePreferences(null));
  vi.unstubAllGlobals();
});

const intersect = (isIntersecting: boolean) =>
  act(() => {
    for (const { element, callback } of [...observed])
      callback(
        [{ isIntersecting, target: element } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
  });

async function show(
  projection: RunProjection,
  {
    session = false,
    arrival = null,
    send = vi.fn(async () => {}),
    locale = 'en',
    sessionId = 'session_advice',
  }: {
    session?: boolean;
    sessionId?: string | null;
    arrival?: AdviceArrivalValue | null;
    send?: (runId: string, executionId: string) => Promise<void>;
    locale?: 'en' | 'ko';
  } = {},
) {
  fixture.store = advisorRunSession({ session });
  fixture.store.setState({ projection });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  const paint = (value: AdviceArrivalValue | null) =>
    act(async () =>
      root.render(
        <IntlProvider locale={locale} messages={locale === 'en' ? messages : ko} timeZone="UTC">
          <AdviceSeenProvider send={send}>
            <AdviceArrival.Provider value={value}>
              <RunMessage
                runId={ADVISOR_RUN}
                sessionId={sessionId}
                live
                onOpenArtifact={vi.fn()}
                runLine={<button type="button">Run #1</button>}
              />
            </AdviceArrival.Provider>
          </AdviceSeenProvider>
        </IntlProvider>,
      ),
    );
  await paint(arrival);
  const set = (next: RunProjection) =>
    act(async () => fixture.store?.setState({ projection: next }));
  /** A person arrives at the row again: the same conversation, a new request. */
  const arrive = (value: AdviceArrivalValue | null) => paint(value);
  return { container, set, send, arrive };
}

/** An arrival at the fixture's run, its end heard. */
const arrival = (key = 1) => ({ runId: ADVISOR_RUN, key, done: vi.fn() });

const base = () =>
  fixture.store?.getState().projection ?? advisorRunSession().getState().projection;
const start = (session = false) =>
  advisorRunSession({ session }).getState().projection as RunProjection;
const part = (container: HTMLElement, name: string) =>
  container.querySelector<HTMLElement>(`[data-chat-part="${name}"]`);
const parts = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[data-chat-part]')]
    .map((node) => node.dataset.chatPart ?? '')
    .filter((value) => !value.startsWith('role:'));
const openLog = (container: HTMLElement) =>
  act(async () =>
    part(container, 'head')?.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click(),
  );

it('draws a delivered advice in its target’s work as a step, saying how its delivery stands', async () => {
  const f = await show(
    withAdvice(start(), [
      {
        adviceId: 'a_cut',
        severity: 'blocker',
        text: 'Stop: the plan deletes the cache.',
        status: 'attached_to_request',
      },
    ]),
  );
  await openLog(f.container);
  const lines = [...f.container.querySelectorAll('[data-advice-line]')].map(
    (line) => line.textContent,
  );
  // The step's label names the advisor once; its line says the rest.
  expect(lines).toEqual([
    'Concern·The brief asks for two sources; the answer cites one.·Waiting to join · read at the next step',
    'Blocker·Stop: the plan deletes the cache.·Delivering',
  ]);
  // The dropped note is nowhere in the conversation.
  expect(f.container.textContent).not.toContain('dropped');
  // Delivered: the same line, only its words change.
  const line = f.container.querySelectorAll('[data-advice-line]')[1];
  await f.set(
    withAdvice(base() as RunProjection, [
      {
        adviceId: 'a_cut',
        severity: 'blocker',
        text: 'Stop: the plan deletes the cache.',
        status: 'delivered',
      },
    ]),
  );
  expect(f.container.querySelectorAll('[data-advice-line]')[1]).toBe(line);
  expect(line?.textContent).toBe('Blocker·Stop: the plan deletes the cache.·Read');
});

it('names the advisor a conversation adds by the one word, once, in its step', async () => {
  const f = await show(start(true), { session: true, locale: 'ko' });
  await openLog(f.container);
  const step = f.container.querySelector('[data-advice-line]')?.closest('.turn-process-row');
  expect(step?.textContent?.split('감독')).toHaveLength(2);
  expect(step?.textContent).not.toContain('session_advisor');
});

it('writes advice its target never read into the tail line, and keeps the row’s parts', async () => {
  const f = await show(start());
  const tail = part(f.container, 'tail');
  expect(tail?.querySelector('[data-advice-line]')).toBeNull();
  // A concern that came after the role ended.
  await f.set(
    endedRun(
      withAdvice(base() as RunProjection, [
        {
          adviceId: 'a_late',
          severity: 'concern',
          text: `\nThe totals skip the last row.${' And more.'.repeat(30)}`,
          status: 'expired',
        },
      ]),
    ),
  );
  expect(parts(f.container)).toEqual(['head', 'body', 'tail']);
  expect(part(f.container, 'tail')).toBe(tail);
  const line = tail?.querySelector('[data-advice-line]');
  expect(line?.textContent?.startsWith('Reviewer·Concern·The totals skip the last row.')).toBe(
    true,
  );
  // In the line itself: nothing new under the tail until the person opens it.
  expect(tail?.className).toContain('whitespace-nowrap');
  expect(line?.getAttribute('aria-expanded')).toBe('false');
  expect(
    document.getElementById(line?.getAttribute('aria-controls') ?? '')?.closest('[hidden]'),
  ).not.toBeNull();
});

it('names several such advice together, and opens them all', async () => {
  const f = await show(
    endedRun(
      withAdvice(start(), [
        { adviceId: 'a_one', severity: 'concern', text: 'First concern.', status: 'expired' },
        { adviceId: 'a_two', severity: 'blocker', text: 'Then a blocker.', status: 'expired' },
        { adviceId: 'a_note', severity: 'nit', text: 'A late note.', status: 'expired' },
      ]),
    ),
  );
  const line = part(f.container, 'tail')?.querySelector<HTMLButtonElement>('[data-advice-line]');
  expect(line?.textContent).toBe('Reviewer·Blocker·2 pieces of advice');
  await act(async () => line?.click());
  const words = document.getElementById(line?.getAttribute('aria-controls') ?? '');
  expect(words?.textContent).toContain('First concern.');
  expect(words?.textContent).toContain('Then a blocker.');
  // A note its target never read is not the tail's: it stays on its line in the work alone.
  expect(part(f.container, 'tail')?.textContent).not.toContain('A late note.');
  expect(words?.textContent).not.toContain('A late note.');
  await openLog(f.container);
  const note = [...f.container.querySelectorAll('.turn-process-row [data-advice-line]')].find(
    (line) => line.textContent?.includes('A late note.'),
  );
  expect(note?.querySelector('[data-advice-state]')?.textContent).toBe(
    messages.Sessions.meta.notDelivered,
  );
});

it('tells the server only once the words are open and on screen, and once', async () => {
  const ended = endedRun(
    withAdvice(start(), [
      { adviceId: 'a_late', severity: 'concern', text: 'Late concern.', status: 'expired' },
    ]),
  );
  const f = await show(ended);
  intersect(true);
  expect(f.send).not.toHaveBeenCalled();
  await act(async () =>
    part(f.container, 'tail')?.querySelector<HTMLButtonElement>('[data-advice-line]')?.click(),
  );
  intersect(true);
  expect(f.send).toHaveBeenCalledWith(ADVISOR_RUN, 'impl_1');
  await act(async () => {});
  intersect(false);
  intersect(true);
  expect(f.send).toHaveBeenCalledTimes(1);
});

it('opens the row’s advice for a person who came from Needs you, and brings its words into view', async () => {
  const ended = endedRun(
    withAdvice(start(), [
      { adviceId: 'a_late', severity: 'blocker', text: 'Late blocker.', status: 'expired' },
    ]),
  );
  const scrolled: Element[] = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  const came = arrival();
  const f = await show(ended, { arrival: came });
  const line = part(f.container, 'tail')?.querySelector('[data-advice-line]');
  expect(line?.getAttribute('aria-expanded')).toBe('true');
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  // Outside a conversation's timeline its words are scrolled to; the arrival is taken once.
  expect(scrolled.some((element) => element.matches('[data-advice-text]'))).toBe(true);
  expect(came.done).toHaveBeenCalledTimes(1);
  intersect(true);
  expect(f.send).toHaveBeenCalledTimes(1);
});

it('opens it again for a person who arrives while the row is already drawn', async () => {
  const ended = endedRun(
    withAdvice(start(), [
      { adviceId: 'a_late', severity: 'blocker', text: 'Late blocker.', status: 'expired' },
    ]),
  );
  const f = await show(ended);
  const line = () => part(f.container, 'tail')?.querySelector('[data-advice-line]');
  expect(line()?.getAttribute('aria-expanded')).toBe('false');
  const came = arrival();
  await f.arrive(came);
  expect(line()?.getAttribute('aria-expanded')).toBe('true');
  expect(came.done).toHaveBeenCalledTimes(1);
  // Folded by the person, then arrived at again from a notification.
  await act(async () => (line() as HTMLButtonElement | null)?.click());
  expect(line()?.getAttribute('aria-expanded')).toBe('false');
  const again = arrival(2);
  await f.arrive(again);
  expect(line()?.getAttribute('aria-expanded')).toBe('true');
  expect(again.done).toHaveBeenCalledTimes(1);
});

it('lets an arrival go at a row with no advice left to read, opening nothing', async () => {
  const came = arrival();
  const f = await show(start(), { arrival: came });
  expect(part(f.container, 'tail')?.querySelector('[data-advice-line]')).toBeNull();
  expect(came.done).toHaveBeenCalledTimes(1);
});

it('opens nothing for an arrival at another run', async () => {
  const ended = endedRun(
    withAdvice(start(), [
      { adviceId: 'a_late', severity: 'blocker', text: 'Late blocker.', status: 'expired' },
    ]),
  );
  const other = { runId: 'run_other', key: 1, done: vi.fn() };
  const f = await show(ended, { arrival: other });
  expect(
    part(f.container, 'tail')?.querySelector('[data-advice-line]')?.getAttribute('aria-expanded'),
  ).toBe('false');
  expect(other.done).not.toHaveBeenCalled();
});

it('counts the advisor neither among the roles nor as work in the head', async () => {
  const f = await show(start());
  const head = part(f.container, 'head');
  expect(head?.textContent).not.toMatch(/\d+ steps?/);
});

it('keeps a line drawn in the work where it stood when its role ends first, saying it was not delivered', async () => {
  const f = await show(start());
  await openLog(f.container);
  const line = f.container.querySelector('[data-advice-line]');
  expect(line?.textContent).toContain('Waiting to join');
  const steps = f.container.querySelectorAll('.turn-process-row').length;
  // The role ends before its next request: the concern waiting for it expires unread.
  const ended = endedRun(base() as RunProjection);
  const directive = ended.directives.dir_advice_1 as RunProjection['directives'][string];
  await f.set({
    ...ended,
    directives: { ...ended.directives, dir_advice_1: { ...directive, status: 'expired' } },
  });
  // The same line in the same place: only its state changes; the tail says it too.
  expect(f.container.querySelector('[data-advice-line]')).toBe(line);
  expect(line?.querySelector('[data-advice-state]')?.textContent).toBe(
    messages.Sessions.meta.notDelivered,
  );
  expect(f.container.querySelectorAll('.turn-process-row').length).toBe(steps);
  expect(part(f.container, 'tail')?.querySelector('[data-advice-line]')).not.toBeNull();
});

it('names advice from several advisors by how many there are, once', async () => {
  const f = await show(
    endedRun(
      withAdvice(start(), [
        { adviceId: 'a_one', severity: 'concern', text: 'First concern.', status: 'expired' },
        {
          adviceId: 'a_two',
          severity: 'blocker',
          text: 'Then a blocker.',
          status: 'expired',
          observer: 'advisor_2',
        },
      ]),
    ),
  );
  const line = part(f.container, 'tail')?.querySelector('[data-advice-line]');
  expect(line?.textContent).toBe('2 advisors·Blocker·2 pieces of advice');
});

it('counts no advisor among the activities of a run outside a conversation', async () => {
  changePreferences({ chatDensity: 'detailed' });
  const f = await show(start(), { sessionId: null });
  const header = f.container.querySelector('.work-log');
  expect(header?.textContent).toContain(`${messages.Desktop.activity} 1`);
});

it('shows a run whose last review was stopped as done: no partial result, no retry', async () => {
  // The run ended well; only its advisor's last review, and that review's request, were stopped.
  const ended = endedRun(start());
  const stopped = {
    ...ended,
    status: 'succeeded',
    executions: {
      ...ended.executions,
      advisor_1: { ...ended.executions.advisor_1, status: 'cancelled' },
    },
    modelCalls: {
      ...ended.modelCalls,
      call_advisor_last: {
        modelCallId: 'call_advisor_last',
        executionId: 'advisor_1',
        finished: true,
        usage: null,
      },
    },
    effects: {
      ...ended.effects,
      effect_advisor_last: {
        effectId: 'effect_advisor_last',
        kind: 'model_request',
        scope: 'advisor_1',
        epoch: 1,
        dispatched: true,
        modelCallId: 'call_advisor_last',
        status: 'settled',
        outcome: 'cancelled',
      },
    },
  } as unknown as RunProjection;
  const f = await show(stopped);
  const text = f.container.textContent ?? '';
  expect(text).not.toContain(messages.Sessions.retryRequest);
  expect(text).not.toMatch(/partial/i);
  expect(text).not.toContain(messages.Status.cancelled);
  expect(part(f.container, 'head')?.textContent).toContain(messages.Presence.state.succeeded);
});
