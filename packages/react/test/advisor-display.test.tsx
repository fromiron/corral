// @vitest-environment jsdom
import type { RunEvent } from '@corral/contracts';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { ExecutionSteering } from '../src/components/ExecutionSteering.tsx';
import { useRequestOwner } from '../src/components/RequestCard.tsx';
import { RunFlowView } from '../src/components/RunFlowView.tsx';
import { EventText } from '../src/components/RunText.tsx';
import { ExecutionTree } from '../src/components/RunView.tsx';
import { UsageInspector } from '../src/components/UsageInspector.tsx';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };
import { buildRunAgentGraph } from '../src/run/agent-graph.ts';
import { buildRunFlow } from '../src/run/flow.ts';
import type { RunSessionStore } from '../src/run/session.ts';
import { buildTranscript } from '../src/run/transcript.ts';
import {
  ADVICE_TEXT,
  advisorDefinition,
  advisorRunEvents,
  advisorRunProjection,
  advisorRunSession,
} from '../src/stories/advisorRunFixture.ts';

// docs/specs/features/advisor.md "보이는 곳" and execution-monitor.md "관계·판단 기록".

const wrap = (children: ReactNode, locale: 'en' | 'ko' = 'en') => (
  <IntlProvider locale={locale} messages={locale === 'en' ? en : ko} timeZone="UTC">
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
        directiveOrigin={(id) => projection.directives[id]?.origin}
      />,
      locale,
    ),
  );
  return container.textContent;
}

const find = <K extends RunEvent['type']>(
  type: K,
  test: (event: RunEvent) => boolean = () => true,
) => advisorRunEvents().find((event) => event.type === type && test(event)) as RunEvent;

describe('run record sentences', () => {
  it('says who advised whom, how severe and how it goes, never that the target followed it', () => {
    const admitted = find('advice.admitted');
    expect(sentence(admitted)).toBe('Reviewer advised Implementer (Concern), for its next request');
    expect(sentence(admitted, 'ko')).toBe(
      'Reviewer의 조언(우려) → Implementer · 다음 요청으로 전달',
    );
    expect(sentence(admitted)).not.toMatch(/follow|appl/i);
  });

  it('says a dropped advice’s severity and the gatekeeper’s reason in words', () => {
    const suppressed = find('advice.suppressed');
    expect(sentence(suppressed)).toBe('Advice from Reviewer dropped (Note): already given');
    expect(sentence(suppressed, 'ko')).toBe('Reviewer의 조언을 버림(참고): 이미 낸 조언');
    expect(sentence(suppressed)).not.toContain('duplicate');
  });

  it('does not call an advice “your instruction”, at acceptance or later', () => {
    const accepted = (origin: string) =>
      find(
        'directive.accepted',
        (event) => (event.payload as { origin?: string }).origin === origin,
      );
    expect(sentence(accepted('user'))).toBe('Your instruction for Implementer was accepted');
    expect(sentence(accepted('advice'))).toBe('Advice for Implementer was accepted');
    expect(sentence(accepted('advice'), 'ko')).toBe('Implementer에 대한 조언 접수');
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
    expect(sentence(later('directive.attached'))).toBe('Advice was attached to a request');
    expect(sentence(later('directive.dispatched'))).toBe('Advice was sent');
    expect(sentence(later('directive.undelivered'))).toBe('Advice was not delivered (expired)');
  });
});

describe('relationships', () => {
  it('shows the advisor in the work flow only once it has advised, as a relation to its target', () => {
    const quiet = advisorRunEvents({ advised: false });
    const before = buildRunFlow(advisorRunProjection(quiet), quiet, definition);
    expect(before.nodes.map((node) => node.id)).not.toContain('agent:reviewer');
    expect(before.edges).toEqual([]);
    const events = advisorRunEvents();
    const after = buildRunFlow(advisorRunProjection(events), events, definition);
    expect(after.nodes.map((node) => node.id)).toContain('agent:reviewer');
    // One relation for the admitted advice; the dropped one makes none.
    expect(after.edges.map((edge) => [edge.kind, edge.from, edge.to, edge.adviceIds])).toEqual([
      ['advice', 'agent:reviewer', 'agent:implementer', ['advice_1']],
    ]);
  });

  it('shows the advisor in the relation graph only once it has advised, never as the lead', () => {
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

  it('lists each advice on its relation with severity, delivery and delivery status', () => {
    const session = advisorRunSession();
    render(
      wrap(
        <RunFlowView
          session={session}
          definition={definition}
          onSelectExecution={() => {}}
          onOpenArtifact={() => {}}
        />,
      ),
    );
    const flow = screen.getByTestId('run-flow');
    expect(within(flow).getAllByText('Concern · Next request · Queued').length).toBeGreaterThan(0);
    expect(flow.textContent).not.toContain('Note');
    expect(flow.textContent).not.toContain(ADVICE_TEXT);
  });
});

describe('the directive list', () => {
  it('marks an advice’s directive with its advisor and severity, and the person’s not', () => {
    const session = advisorRunSession();
    const { container } = render(
      wrap(
        <ExecutionSteering
          session={session}
          target={{ executionId: 'impl_1', nodeLabel: 'Implementer', finished: false }}
          compose={null}
          planSlot={null}
        />,
      ),
    );
    const advice = container.querySelector('#directive-dir_advice_1');
    const own = container.querySelector('#directive-dir_user_1');
    expect(advice?.querySelector('[data-directive-advice]')?.textContent).toBe(
      'Reviewer · Concern',
    );
    expect(own?.querySelector('[data-directive-advice]')).toBeNull();
    // The person's actions (now, remove) are not offered on an advice.
    expect(advice?.querySelectorAll('button')).toHaveLength(0);
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
    expect(within(worker).getAllByText('Waiting for an answer').length).toBeGreaterThan(0);
    expect(within(worker).queryByText('Watching')).toBeNull();
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
