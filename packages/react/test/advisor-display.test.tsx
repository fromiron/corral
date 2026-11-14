// @vitest-environment jsdom
import { RunEvent } from '@corral/contracts';
import { applyEvent } from '@corral/core';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionSteering } from '../src/components/ExecutionSteering.tsx';
import { useRequestOwner } from '../src/components/RequestCard.tsx';
import { RunCanvas } from '../src/components/RunCanvas.tsx';
import { EventText } from '../src/components/RunText.tsx';
import { ExecutionTree } from '../src/components/RunView.tsx';
import { Timeline } from '../src/components/Timeline.tsx';
import { UsageInspector } from '../src/components/UsageInspector.tsx';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };
import { buildRunAgentGraph } from '../src/run/agent-graph.ts';
import type { RunSessionStore } from '../src/run/session.ts';
import { buildTranscript } from '../src/run/transcript.ts';
import {
  ADVISOR_RUN,
  advisorDefinition,
  advisorRunEvents,
  advisorRunProjection,
  advisorRunSession,
} from '../src/stories/advisorRunFixture.ts';

// docs/specs/features/advisor.md "보이는 곳" and execution-monitor.md "관계·판단 기록".

const wrap = (
  children: ReactNode,
  locale: 'en' | 'ko' = 'en',
  onError: (error: Error) => void = () => {},
) => (
  <IntlProvider
    locale={locale}
    messages={locale === 'en' ? en : ko}
    timeZone="UTC"
    onError={onError}
  >
    {children}
  </IntlProvider>
);

const definition = advisorDefinition();
const nodeLabel = (id: string) => definition.nodes.find((node) => node.id === id)?.label ?? id;

function sentence(event: RunEvent, locale: 'en' | 'ko' = 'en') {
  const projection = advisorRunProjection();
  const labelOf = (executionId: string | undefined) =>
    nodeLabel(projection.executions[executionId ?? '']?.nodeId ?? '');
  const { container } = render(
    wrap(
      <EventText
        event={event}
        labelOf={labelOf}
        nodeLabel={nodeLabel}
        context={{
          directiveOrigin: (id) => projection.directives[id]?.origin,
          advisor: (id) => projection.executions[id]?.advisor === true,
        }}
      />,
      locale,
    ),
  );
  return container;
}
const said = (event: RunEvent, locale: 'en' | 'ko' = 'en') => sentence(event, locale).textContent;

const find = <K extends RunEvent['type']>(
  type: K,
  test: (event: RunEvent) => boolean = () => true,
) => advisorRunEvents().find((event) => event.type === type && test(event)) as RunEvent;

/** The events view's virtual list measures its box; give it one in jsdom. */
function sized() {
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800),
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800),
  ];
  return () => {
    for (const spy of spies) spy.mockRestore();
  };
}

/** A session whose run went one event further than the fixture. */
function sessionWith(session: RunSessionStore, type: string, payload: object, executionId: string) {
  const state = session.getState();
  const event = RunEvent.parse({
    schemaVersion: '0.1',
    eventId: `event_${state.events.length + 1}`,
    runId: ADVISOR_RUN,
    runSeq: state.events.length + 1,
    recordedAt: '2026-11-13T00:01:00.000Z',
    actor: { kind: 'runtime', id: 'runtime' },
    causedByEventIds: [],
    executionId,
    type,
    payload,
  });
  const projection = state.projection;
  if (!projection) throw new Error('fixture');
  session.setState({
    events: [...state.events, event],
    projection: { ...applyEvent(projection, event), status: 'running' },
  });
  return session;
}

describe('run record sentences', () => {
  it('says who advised whom, how severe and how it goes, never that the target followed it', () => {
    const admitted = find('advice.admitted');
    expect(said(admitted)).toBe('Reviewer advised Implementer (Concern), for its next request');
    expect(said(admitted, 'ko')).toBe('Reviewer의 조언(우려) → Implementer · 다음 요청으로 전달');
    expect(said(admitted)).not.toMatch(/follow|appl/i);
  });

  it('says a dropped advice’s severity and the gatekeeper’s reason in words', () => {
    const suppressed = find('advice.suppressed');
    expect(said(suppressed)).toBe('Advice from Reviewer dropped (Note): already given');
    expect(said(suppressed, 'ko')).toBe('Reviewer의 조언을 버림(참고): 이미 낸 조언');
    expect(said(suppressed)).not.toContain('duplicate');
  });

  it('keeps an advisor’s name from turning the sentence around it', () => {
    // A name with a right-to-left override stays inside its own isolate.
    for (const event of [find('advice.admitted'), find('advice.suppressed')])
      expect([...sentence(event).querySelectorAll('bdi')].map((bdi) => bdi.textContent)).toContain(
        'Reviewer',
      );
  });

  it('does not call an advice “your instruction”, at acceptance or later', () => {
    const accepted = (origin: string) =>
      find(
        'directive.accepted',
        (event) => (event.payload as { origin?: string }).origin === origin,
      );
    expect(said(accepted('user'))).toBe('Your instruction for Implementer was accepted');
    expect(said(accepted('advice'))).toBe('Advice for Implementer was accepted');
    expect(said(accepted('advice'), 'ko')).toBe('Implementer에 대한 조언 접수');
    const later = (type: 'directive.attached' | 'directive.dispatched' | 'directive.undelivered') =>
      ({
        ...find('directive.accepted'),
        type,
        payload: {
          directiveId: 'dir_advice_1',
          contextSnapshotId: 'snapshot',
          modelCallId: 'call',
          executionEpoch: 1,
          status: 'expired',
          reason: 'target ended',
        },
      }) as unknown as RunEvent;
    expect(said(later('directive.attached'))).toBe('Advice was attached to a request');
    expect(said(later('directive.dispatched'))).toBe('Advice was sent');
    expect(said(later('directive.undelivered'))).toBe('Advice was not delivered (expired)');
  });

  it('tells the events view who made a directive and which execution advises', () => {
    const session = sessionWith(
      advisorRunSession(),
      'directive.attached',
      { directiveId: 'dir_advice_1', contextSnapshotId: 'snapshot_2', modelCallId: 'call_2' },
      'impl_1',
    );
    const restore = sized();
    try {
      render(wrap(<Timeline session={session} />));
      expect(screen.getByText('Advice was attached to a request')).toBeTruthy();
      expect(screen.getByText('Reviewer: watching')).toBeTruthy();
    } finally {
      restore();
    }
  });
});

describe('the relation graph', () => {
  it('shows the advisor only once it has advised, never as the lead', () => {
    const quiet = advisorRunProjection(advisorRunEvents({ advised: false }));
    const before = buildRunAgentGraph(quiet, definition);
    expect(before.nodes.map((node) => node.id)).toEqual(['implementer']);
    expect(before.relations).toEqual([]);
    const after = buildRunAgentGraph(advisorRunProjection(), definition);
    expect(after.nodes.map((node) => [node.id, node.lead])).toEqual([
      ['implementer', true],
      ['reviewer', false],
    ]);
    expect(
      after.relations.map((relation) => [relation.kind, relation.source, relation.target]),
    ).toEqual([['advice', 'reviewer', 'implementer']]);
    expect(after.relations[0]).toMatchObject({ count: 1, activeCount: 0 });
  });

  it('counts every advice on one relation, and draws it as “Advice n”', () => {
    const session = advisorRunSession();
    const projection = session.getState().projection;
    if (!projection) throw new Error('fixture');
    session.setState({
      projection: {
        ...projection,
        advice: {
          ...projection.advice,
          advice_2: {
            adviceId: 'advice_2',
            observerExecutionId: 'advisor_1',
            targetExecutionId: 'impl_1',
            severity: 'blocker',
            delivery: 'preserve',
            directiveId: null,
            note: 'Stop before the migration.',
            acceptedSeq: 99,
          },
        },
      },
    });
    const graph = buildRunAgentGraph(session.getState().projection, definition);
    expect(graph.relations.map((relation) => [relation.kind, relation.count])).toEqual([
      ['advice', 2],
    ]);
    const { container } = render(
      wrap(
        <RunCanvas
          session={session}
          definition={definition}
          selectedNodeId={null}
          onSelectNode={() => {}}
        />,
      ),
    );
    expect(container.innerHTML).toContain('Advice 2');
  });

  it('reads the resting advisor as watching', () => {
    const { container } = render(
      wrap(
        <RunCanvas
          session={advisorRunSession()}
          definition={definition}
          display="list"
          selectedNodeId={null}
          onSelectNode={() => {}}
        />,
      ),
    );
    expect(container.textContent).toContain('Watching');
    expect(container.textContent).not.toContain('Waiting for a reply');
  });
});

describe('the directive list', () => {
  const list = (session: RunSessionStore, locale: 'en' | 'ko' = 'en', onError?: () => void) =>
    render(
      wrap(
        <ExecutionSteering
          session={session}
          target={{ executionId: 'impl_1', nodeLabel: 'Implementer', finished: false }}
          compose={null}
          planSlot={null}
        />,
        locale,
        onError,
      ),
    ).container;

  it('marks an advice’s directive with its advisor and severity, and the person’s not', () => {
    const container = list(advisorRunSession());
    const advice = container.querySelector('#directive-dir_advice_1');
    const own = container.querySelector('#directive-dir_user_1');
    const from = advice?.querySelector('[data-directive-advice]');
    expect(from?.textContent).toBe('Reviewer · Concern');
    // The advisor's name is isolated from the line around it.
    expect(from?.querySelector('bdi')?.textContent).toBe('Reviewer');
    expect(own?.querySelector('[data-directive-advice]')).toBeNull();
    // The person's actions (now, remove) are not offered on an advice.
    expect(advice?.querySelectorAll('button')).toHaveLength(0);
  });

  it('shows a severity it has no name for as it was recorded, without an error', () => {
    const session = advisorRunSession();
    const projection = session.getState().projection;
    const directive = projection?.directives.dir_advice_1;
    if (!projection || !directive?.advice) throw new Error('fixture');
    session.setState({
      projection: {
        ...projection,
        directives: {
          ...projection.directives,
          dir_advice_1: {
            ...directive,
            advice: { ...directive.advice, severity: 'critical' as never },
          },
        },
      },
    });
    const onError = vi.fn();
    const container = list(session, 'en', onError);
    expect(container.querySelector('[data-directive-advice]')?.textContent).toBe(
      'Reviewer · critical',
    );
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('the execution tree', () => {
  it('says once, beside its name, that the advisor is one, and reads its rest as watching', () => {
    render(wrap(<ExecutionTree session={advisorRunSession()} onSteer={() => {}} />));
    const advisor = screen.getByTestId('execution-advisor_1');
    expect(within(advisor).getAllByText('Advisor')).toHaveLength(1);
    expect(within(advisor).getByText('Watching')).toBeTruthy();
    expect(advisor.textContent).not.toContain('Waiting for an answer');
    expect(within(advisor).queryByTestId('waiting-on')).toBeNull();
    // The name keeps its own direction: a model-written override cannot turn the card around.
    expect(within(advisor).getByText('Reviewer').closest('[dir]')).not.toBeNull();
    const worker = screen.getByTestId('execution-impl_1');
    expect(within(worker).queryByText('Advisor')).toBeNull();
  });

  it('keeps a working execution’s message wait as waiting for an answer', () => {
    const session = advisorRunSession();
    const projection = session.getState().projection;
    if (!projection) throw new Error('fixture');
    const impl = projection.executions.impl_1;
    if (!impl) throw new Error('fixture');
    session.setState({
      projection: {
        ...projection,
        executions: {
          ...projection.executions,
          impl_1: { ...impl, status: 'waiting_message' },
        },
      },
    });
    render(wrap(<ExecutionTree session={session} onSteer={() => {}} />));
    const worker = screen.getByTestId('execution-impl_1');
    // In the presence's words: its state, and what it waits for beside it.
    expect(within(worker).getAllByText('Working · Waiting for a reply').length).toBeGreaterThan(0);
    expect(within(worker).queryByText('Watching')).toBeNull();
  });

  it('counts the advisor as an execution but never as running', () => {
    const { container } = render(
      wrap(<ExecutionTree session={advisorRunSession()} onSteer={() => {}} />),
    );
    const bar = container.querySelector('header');
    expect(bar?.textContent).toContain('2 executions');
    const working = (count: number) => en.Run.tree.running.replace('{count}', String(count));
    expect(bar?.textContent).toContain(working(1));
    expect(bar?.textContent).not.toContain(working(2));
  });
});

describe('the advisor a conversation adds', () => {
  const session = () => advisorRunSession({ session: true });

  it('is called “advisor” once in the tree, in the reader’s language, with no badge over it', () => {
    for (const [locale, word] of [
      ['en', 'Advisor'],
      ['ko', '감독'],
    ] as const) {
      const { unmount } = render(
        wrap(<ExecutionTree session={session()} onSteer={() => {}} />, locale),
      );
      const advisor = screen.getByTestId('execution-advisor_1');
      expect(within(advisor).getAllByText(word)).toHaveLength(1);
      expect(advisor.textContent).not.toContain(word === '감독' ? 'Advisor' : '감독');
      unmount();
    }
  });

  it('is called “advisor” in the events and the directive list too', () => {
    const restore = sized();
    try {
      const { unmount } = render(wrap(<Timeline session={session()} />, 'ko'));
      const line = '감독의 조언(우려) → Implementer · 다음 요청으로 전달';
      // The names sit in their own isolates, so the line is matched whole.
      expect(document.body.textContent).toContain(line);
      unmount();
    } finally {
      restore();
    }
    render(
      wrap(
        <ExecutionSteering
          session={session()}
          target={{ executionId: 'impl_1', nodeLabel: 'Implementer', finished: false }}
          compose={null}
          planSlot={null}
        />,
        'ko',
      ),
    );
    expect(document.querySelector('[data-directive-advice]')?.textContent).toBe('감독 · 우려');
  });

  it('is called “advisor” on the relation graph', () => {
    const { container } = render(
      wrap(
        <RunCanvas
          session={session()}
          definition={advisorDefinition({ session: true })}
          display="list"
          selectedNodeId={null}
          onSelectNode={() => {}}
        />,
        'ko',
      ),
    );
    expect(container.textContent).toContain('감독');
    expect(container.textContent).not.toContain('Advisor');
  });
});

describe('counts and usage', () => {
  function Owner({ session }: { session: RunSessionStore }) {
    const owner = useRequestOwner(session);
    return <span data-testid="owner">{owner({ executionId: 'impl_1' }) ?? ''}</span>;
  }

  it('does not count the advisor as one of the run’s roles', () => {
    render(wrap(<Owner session={advisorRunSession()} />));
    // A lone working role names nobody: the advisor beside it is not a second role.
    expect(screen.getByTestId('owner').textContent).toBe('');
  });

  it('shows the advisor’s usage under its own role', () => {
    const { container } = render(wrap(<UsageInspector session={advisorRunSession()} />));
    const row = container.querySelector('[data-usage-agent="reviewer"]');
    expect(row?.textContent).toContain('Reviewer');
    expect(row?.textContent).toContain('120');
  });

  it('never puts a dropped advice into a conversation transcript', () => {
    const events = advisorRunEvents();
    const projection = advisorRunProjection(events);
    for (const executionId of ['impl_1', 'advisor_1']) {
      const entries = buildTranscript(events, projection, {}, executionId);
      expect(entries.filter((entry) => entry.kind === 'advice')).toHaveLength(
        executionId === 'impl_1' ? 1 : 0,
      );
      expect(JSON.stringify(entries)).not.toContain('duplicate');
    }
  });
});

describe('the advisor’s rest in the timeline', () => {
  it('says a resting advisor watches, and a worker still waits for an answer', () => {
    const rest = advisorRunEvents().at(-1) as RunEvent;
    expect(rest.type).toBe('execution.state_changed');
    expect(said(rest)).toBe('Reviewer: watching');
    expect(said(rest, 'ko')).toBe('Reviewer: 지켜보는 중');
    const worker = {
      ...rest,
      executionId: 'impl_1',
      payload: { ...rest.payload, executionId: 'impl_1' },
    } as RunEvent;
    expect(said(worker)).toBe('Implementer: waiting for an answer');
  });
});
