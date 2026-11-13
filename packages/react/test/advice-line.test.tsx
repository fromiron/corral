// @vitest-environment jsdom
import { RunEvent } from '@corral/contracts';
import { applyEvent, emptyProjection, type RunProjection } from '@corral/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdviceSummary, AdviceText } from '../src/components/AdviceLine.tsx';
import { ExecutionTranscript } from '../src/components/ExecutionTranscript.tsx';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };
import { AdviceSeenProvider, createAdviceSeen } from '../src/run/adviceSeen.tsx';
import { deliveredAdvice, firstLine, unreadAdviceOf } from '../src/run/advisor.ts';
import { buildTurnProcess, turnSummary } from '../src/run/turn-process.ts';
import {
  ADVICE_TEXT,
  ADVISOR_RUN,
  advisorDefinition,
  advisorRunProjection,
  advisorRunSession,
  endedRun,
  withAdvice,
} from '../src/stories/advisorRunFixture.ts';

// docs/specs/features/advisor.md "조언" and "보이는 곳"; features/inbox.md `advice` (seeing it in
// full is what clears it); execution-monitor.md (its words are in its target's record).

const wrap = (children: ReactNode, locale: 'en' | 'ko' = 'en') => (
  <IntlProvider locale={locale} messages={locale === 'en' ? en : ko} timeZone="UTC">
    {children}
  </IntlProvider>
);

/** IntersectionObserver as the page would run it, moved by the test. */
const observed: { element: Element; callback: IntersectionObserverCallback }[] = [];
beforeEach(() => {
  observed.length = 0;
  Element.prototype.getAnimations ??= () => [];
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
});
afterEach(() => vi.unstubAllGlobals());
const intersect = (isIntersecting: boolean) =>
  act(() => {
    for (const { element, callback } of [...observed])
      callback(
        [{ isIntersecting, target: element } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
  });

const base = advisorRunProjection();

describe('where an advice stands', () => {
  it('shows an advice on its way or delivered in its target’s work, in the words a person’s instruction uses', () => {
    const projection = withAdvice(base, [
      { adviceId: 'a_wait', severity: 'nit', text: 'Name the file.', status: 'queued' },
      {
        adviceId: 'a_after',
        severity: 'concern',
        text: 'Check the claim.',
        status: 'queued',
      },
      {
        adviceId: 'a_going',
        severity: 'concern',
        text: 'Look again.',
        status: 'attached_to_request',
      },
      { adviceId: 'a_read', severity: 'concern', text: 'Cite two.', status: 'delivered' },
    ]);
    const waiting = {
      ...projection,
      executions: {
        ...projection.executions,
        impl_1: { ...(projection.executions.impl_1 as RunProjection['executions'][string]) },
      },
    };
    expect(deliveredAdvice(waiting, 'impl_1').map((item) => [item.adviceId, item.state])).toEqual([
      ['advice_1', 'waiting'],
      ['a_wait', 'waiting'],
      ['a_after', 'waiting'],
      ['a_going', 'delivering'],
      ['a_read', 'read'],
    ]);
    // Waiting on the person: read after the decision.
    const asking = {
      ...waiting,
      executions: {
        ...waiting.executions,
        impl_1: {
          ...(waiting.executions.impl_1 as RunProjection['executions'][string]),
          status: 'waiting_approval' as const,
        },
      },
    };
    expect(
      deliveredAdvice(asking, 'impl_1').find((item) => item.adviceId === 'a_after')?.state,
    ).toBe('afterDecision');
  });

  it('says a blocker interrupted only when it cut a response, and was read otherwise', () => {
    const delivered = withAdvice(base, [
      {
        adviceId: 'a_cut',
        severity: 'blocker',
        text: 'Stop: the migration drops a table.',
        status: 'delivered',
        modelCallId: 'call_impl_2',
      },
    ]);
    const calls = (interrupted: boolean): RunProjection => ({
      ...delivered,
      modelCalls: {
        ...delivered.modelCalls,
        call_impl_1: {
          ...(delivered.modelCalls.call_impl_1 as RunProjection['modelCalls'][string]),
          ...(interrupted ? { interrupted: true as const } : {}),
        },
        call_impl_2: {
          ...(delivered.modelCalls.call_impl_1 as RunProjection['modelCalls'][string]),
          modelCallId: 'call_impl_2',
        },
      },
    });
    const state = (projection: RunProjection) =>
      deliveredAdvice(projection, 'impl_1').find((item) => item.adviceId === 'a_cut')?.state;
    expect(state(calls(true))).toBe('interrupted');
    expect(state(calls(false))).toBe('read');
  });

  it('keeps a concern or blocker its target ended before reading for the tail, and drops a note', () => {
    const projection = endedRun(
      withAdvice(base, [
        { adviceId: 'a_late', severity: 'concern', text: 'Late concern.', status: 'expired' },
        { adviceId: 'a_stop', severity: 'blocker', text: 'Late blocker.', status: 'not_delivered' },
        { adviceId: 'a_note', severity: 'nit', text: 'Late note.', status: 'expired' },
        {
          adviceId: 'a_kept',
          severity: 'concern',
          text: 'Kept for an ended target.',
          delivery: 'preserve',
        },
      ]),
    );
    const delivered = deliveredAdvice(projection, 'impl_1').map((item) => item.adviceId);
    expect(delivered).not.toContain('a_late');
    expect(delivered).not.toContain('a_stop');
    expect(delivered).not.toContain('a_note');
    expect(delivered).not.toContain('a_kept');
    expect(unreadAdviceOf(projection).map((item) => [item.adviceId, item.text])).toEqual([
      ['a_late', 'Late concern.'],
      ['a_stop', 'Late blocker.'],
      ['a_kept', 'Kept for an ended target.'],
    ]);
  });

  it('keeps an advice to an attempt that was retried with that attempt, not the new one', () => {
    const failed = withAdvice(base, [
      { adviceId: 'a_old', severity: 'concern', text: 'Old attempt.', status: 'expired' },
    ]);
    const impl = failed.executions.impl_1 as RunProjection['executions'][string];
    const retried: RunProjection = {
      ...failed,
      executions: {
        ...failed.executions,
        impl_1: { ...impl, status: 'failed' },
        impl_2: {
          ...impl,
          executionId: 'impl_2',
          attemptNo: 2,
          previousExecutionId: 'impl_1',
          status: 'active',
        },
      },
      executionOrder: [...failed.executionOrder, 'impl_2'],
    };
    expect(deliveredAdvice(retried, 'impl_2')).toEqual([]);
    expect(unreadAdviceOf(retried).map((item) => [item.adviceId, item.targetExecutionId])).toEqual([
      ['a_old', 'impl_1'],
    ]);
  });

  it('names an advice by its first line that has text', () => {
    expect(firstLine('\n\n   Check the bound.  \nIt is off by one.')).toBe('Check the bound.');
    expect(firstLine(' \n\t\n')).toBe('');
  });
});

describe('the work it stands in', () => {
  it('places an advice where it was accepted among its target’s steps, and the dropped one nowhere', () => {
    const session = advisorRunSession();
    const { events } = session.getState();
    const projection = advisorRunProjection();
    const process = buildTurnProcess(events, projection, {}, (id) => id);
    // The fixture accepted its concern after the implementer's first request.
    expect(process.rows.map((row) => row.kind)).toEqual(['model', 'advice']);
    const advice = process.rows[1];
    expect(advice?.kind === 'advice' && [advice.severity, advice.text, advice.state]).toEqual([
      'concern',
      ADVICE_TEXT,
      'waiting',
    ]);
  });

  it('keeps an advice before the requests that came after it', () => {
    const { events } = advisorRunSession().getState();
    const later = RunEvent.parse({
      ...events[3],
      eventId: 'event_later',
      runSeq: events.length + 1,
      type: 'model.request_prepared',
      executionId: 'impl_1',
      payload: {
        executionId: 'impl_1',
        modelCallId: 'call_impl_2',
        contextSnapshotId: 'snapshot_call_impl_2',
        profile: 'model-a',
        configRevision: 0,
        directiveIds: ['dir_advice_1'],
        inputArtifactVersionIds: [],
      },
    });
    const all = [...events, later];
    const projection = all.reduce(applyEvent, emptyProjection(ADVISOR_RUN));
    const process = buildTurnProcess(all, projection, {}, (id) => id);
    expect(process.rows.map((row) => row.kind)).toEqual(['model', 'advice', 'model']);
  });

  it('never counts the advisor among the roles, the steps or the work going on', () => {
    const session = advisorRunSession();
    const projection = advisorRunProjection();
    const process = buildTurnProcess(session.getState().events, projection, {}, (id) => id);
    expect(process.rows.some((row) => row.kind === 'agent')).toBe(false);
    expect(process.steps).toBe(0);
    // The advisor is reviewing; the implementer has stopped working.
    const reviewing: RunProjection = {
      ...projection,
      executions: {
        ...projection.executions,
        impl_1: {
          ...(projection.executions.impl_1 as RunProjection['executions'][string]),
          status: 'waiting_message',
        },
        advisor_1: {
          ...(projection.executions.advisor_1 as RunProjection['executions'][string]),
          status: 'active',
        },
      },
    };
    const summary = turnSummary(reviewing);
    expect(summary.steps).toBe(0);
    expect(summary.active).toBe(false);
    expect(buildTurnProcess([], reviewing, {}, (id) => id).active).toBe(false);
  });
});

describe('the line', () => {
  const item = (text: string, severity: 'nit' | 'concern' | 'blocker' = 'concern') => ({
    adviceId: `advice_${text.length}`,
    observerExecutionId: 'advisor_1',
    targetExecutionId: 'impl_1',
    severity,
    text,
    seq: 1,
  });

  it('is the advisor · severity · first line · state, and its words open under it', () => {
    const rtl = '‮ecivda desrever‬';
    render(
      wrap(
        <>
          <AdviceSummary
            name={rtl}
            items={[item(`\n\n${rtl} first\nsecond`)]}
            status="Read"
            open={false}
            controls="words"
            onToggle={() => {}}
          />
          <AdviceText
            id="words"
            open
            items={[item(`\n\n${rtl} first\nsecond`)]}
            nameOf={() => ''}
          />
        </>,
      ),
    );
    const line = document.querySelector('[data-advice-line]') as HTMLElement;
    expect(line.textContent).toBe(`${rtl}·Concern·${rtl} first·Read`);
    // The advisor's name and its first line are a model's or a team's words: each is isolated.
    expect([...line.querySelectorAll('bdi')].map((bdi) => bdi.textContent)).toEqual([
      rtl,
      `${rtl} first`,
    ]);
    // The words in full keep their own direction and start at their first line.
    const words = document.querySelector('[data-advice-text] p[dir="auto"]');
    expect(words?.textContent).toBe(`${rtl} first\nsecond`);
    // One line high: the first line is the part that gives way.
    expect(line.className).toContain('whitespace-nowrap');
    expect(line.querySelectorAll('bdi')[1]?.className).toContain('truncate');
  });

  it('names several advice by their gravest severity and how many there are', () => {
    render(
      wrap(
        <AdviceSummary
          name="Reviewer"
          items={[item('One.', 'concern'), item('Two words.', 'blocker')]}
          open={false}
          controls="x"
          onToggle={() => {}}
        />,
        'ko',
      ),
    );
    expect(document.querySelector('[data-advice-line]')?.textContent).toBe(
      'Reviewer·중단 권고·조언 2건',
    );
  });

  it('does not say again, open, the first line its words begin with', () => {
    const one = [item('First line.\nThe rest.')];
    const view = (open: boolean) => (
      <>
        <AdviceSummary
          name="Reviewer"
          items={one}
          status="Read"
          open={open}
          controls="words"
          onToggle={() => {}}
        />
        <AdviceText id="words" open={open} items={one} nameOf={() => 'Reviewer'} />
      </>
    );
    const { rerender } = render(wrap(view(false)));
    const line = document.querySelector('[data-advice-line]') as HTMLElement;
    expect(line.textContent).toBe('Reviewer·Concern·First line.·Read');
    rerender(wrap(view(true)));
    // The name, the severity and the state stay; the first line is the words' own.
    expect(line.textContent).toBe('Reviewer·Concern·Read');
    const words = document.querySelector('[data-advice-text]') as HTMLElement;
    expect(words.textContent).toBe('First line.\nThe rest.');
  });

  it('opens several of one advisor as their severities and words, the name said once by the line', () => {
    const several = [item('One.', 'concern'), item('Two words.', 'blocker')];
    render(
      wrap(
        <>
          <AdviceSummary
            name="Reviewer"
            items={several}
            open
            controls="words"
            onToggle={() => {}}
          />
          <AdviceText id="words" open items={several} nameOf={() => 'Reviewer'} />
        </>,
      ),
    );
    expect(document.body.textContent?.split('Reviewer').length).toBe(2);
    const words = document.querySelector('[data-advice-text]') as HTMLElement;
    expect(words.textContent).toBe('ConcernOne.BlockerTwo words.');
  });

  it('names each advisor over its words only when several advisors gave them', () => {
    const several = [
      item('One.', 'concern'),
      { ...item('Two words.', 'blocker'), observerExecutionId: 'advisor_2' },
    ];
    render(
      wrap(
        <AdviceText
          id="words"
          open
          items={several}
          nameOf={(advice) => (advice.observerExecutionId === 'advisor_2' ? 'Tester' : 'Reviewer')}
        />,
      ),
    );
    const words = document.querySelector('[data-advice-text]') as HTMLElement;
    expect(words.textContent).toBe('Reviewer·ConcernOne.Tester·BlockerTwo words.');
  });
});

describe('seeing it', () => {
  const unread = endedRun(
    withAdvice(base, [
      { adviceId: 'a_late', severity: 'concern', text: 'Late concern.', status: 'expired' },
    ]),
  );
  const session = (projection: RunProjection) => {
    const store = advisorRunSession();
    store.setState({ projection });
    return store;
  };
  const record = (send: (runId: string, executionId: string) => Promise<void>, open = false) =>
    render(
      wrap(
        <AdviceSeenProvider send={send}>
          <ExecutionTranscript session={session(unread)} executionId="impl_1" adviceOpen={open} />
        </AdviceSeenProvider>,
      ),
    );

  it('ends its target’s record with the advice it never read', () => {
    const { container } = record(async () => {});
    const blocks = container.querySelectorAll('[data-advice]');
    expect(blocks[blocks.length - 1]?.getAttribute('data-advice')).toBe('unread');
    expect(blocks[blocks.length - 1]?.textContent).toContain('Reviewer·Concern·Late concern.');
  });

  it('tells nothing while the words are folded, even on screen', () => {
    const send = vi.fn(async () => {});
    record(send);
    intersect(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('tells once when the words are open and on screen, not when open off screen', () => {
    const send = vi.fn(async () => {});
    const { container } = record(send);
    const line = [...container.querySelectorAll('[data-advice="unread"] [data-advice-line]')][0];
    act(() => fireEvent.click(line as Element));
    intersect(false);
    expect(send).not.toHaveBeenCalled();
    intersect(true);
    expect(send).toHaveBeenCalledWith('run_advisor', 'impl_1');
    intersect(false);
    intersect(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('tells again when a new advice comes to the row whose words are shown (the server lists it again)', () => {
    const send = vi.fn(async () => {});
    const store = session(unread);
    render(
      wrap(
        <AdviceSeenProvider send={send}>
          <ExecutionTranscript session={store} executionId="impl_1" adviceOpen />
        </AdviceSeenProvider>,
      ),
    );
    intersect(true);
    expect(send).toHaveBeenCalledTimes(1);
    // The last review leaves another at the same row after it was opened.
    act(() =>
      store.setState({
        projection: endedRun(
          withAdvice(base, [
            { adviceId: 'a_late', severity: 'concern', text: 'Late concern.', status: 'expired' },
            { adviceId: 'a_last', severity: 'blocker', text: 'Last blocker.', status: 'expired' },
          ]),
        ),
      }),
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith('run_advisor', 'impl_1');
  });

  it('tells again the next time it is shown when telling failed', async () => {
    const send = vi.fn(async () => {
      throw new Error('offline');
    });
    record(send, true);
    intersect(true);
    await act(async () => {});
    expect(send).toHaveBeenCalledTimes(1);
    intersect(false);
    intersect(true);
    await act(async () => {});
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('tells each advice once, by its execution, however often it is shown', async () => {
    const send = vi.fn(async () => {});
    const seen = createAdviceSeen(send);
    const a = { adviceId: 'a', targetExecutionId: 'impl_1' };
    const b = { adviceId: 'b', targetExecutionId: 'impl_1' };
    seen.seen('run', [a, b]);
    seen.seen('run', [a, b]);
    await act(async () => {});
    seen.seen('run', [a, b]);
    expect(send).toHaveBeenCalledTimes(1);
    // A new one on the same row is told; the server's row is opened again, which changes nothing.
    seen.seen('run', [a, b, { adviceId: 'c', targetExecutionId: 'impl_1' }]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('draws a delivered advice where it was accepted in the record, with how its delivery stands', () => {
    const store = advisorRunSession();
    render(wrap(<ExecutionTranscript session={store} executionId="impl_1" />));
    const block = document.querySelector('[data-advice="delivered"]');
    expect(block?.textContent).toContain(
      'Reviewer·Concern·The brief asks for two sources; the answer cites one.·Waiting to join · read at the next step',
    );
    expect(screen.queryByText('with your instruction')).toBeNull();
  });

  it('calls a request that carried only advice so, never “with your instruction”', () => {
    const store = advisorRunSession();
    const state = store.getState();
    const projection = state.projection as RunProjection;
    const prepared = state.events.find((event) => event.type === 'model.request_prepared');
    if (!prepared || prepared.type !== 'model.request_prepared') throw new Error('fixture');
    const carried = {
      ...prepared,
      payload: { ...prepared.payload, directiveIds: ['dir_advice_1'] },
    };
    store.setState({
      events: state.events.map((event) => (event === prepared ? carried : event)),
      projection,
    });
    render(wrap(<ExecutionTranscript session={store} executionId="impl_1" />));
    expect(screen.queryByText('with your instruction')).toBeNull();
    expect(screen.getByText('with advice')).toBeTruthy();
  });
});

it('the advisor a conversation adds is named once, by the one word, on its line', () => {
  const store = advisorRunSession({ session: true });
  const projection = endedRun(
    withAdvice(store.getState().projection as RunProjection, [
      { adviceId: 'a_late', severity: 'blocker', text: 'Late blocker.', status: 'expired' },
    ]),
  );
  store.setState({ projection, definition: advisorDefinition({ session: true }) });
  render(wrap(<ExecutionTranscript session={store} executionId="impl_1" />, 'ko'));
  const unread = document.querySelector('[data-advice="unread"] [data-advice-line]');
  expect(unread?.textContent).toBe('감독·중단 권고·Late blocker.');
});
