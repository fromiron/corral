// @vitest-environment jsdom
import { RunEvent } from '@corral/contracts';
import { act, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { useQuestionNotice, type WaitingQuestion } from './questionNotice.ts';
import { ComposerActivity } from './session/ComposerActivity.tsx';
import {
  createPendingTrayStore,
  PendingTrayContext,
  type PendingTrayStore,
} from './session/pendingTrayState.ts';
import { presentContext } from './widgets/selectors.ts';
import type { ChatWidgetModel } from './widgets/useChatWidgets.tsx';

// The activity bar names a waiting question while the conversation's needed-now tray, where it
// is answered, is out of view (composer-flow.md "활동 바"). Its words come from here: the first
// question's own line, the count beside it from two, and the body read when the run's texts do
// not hold it yet.

const fixture = vi.hoisted(() => ({ model: null as ChatWidgetModel | null }));
vi.mock('./widgets/useChatWidgets.tsx', () => ({ useChatWidget: () => fixture.model }));
vi.mock('../services.tsx', () => ({ useServices: () => ({ runFor: () => null }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a href="#run" className={className}>
      {children}
    </a>
  ),
}));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

const question = (requestId: string, runSeq: number): WaitingQuestion => ({
  kind: 'question',
  event: RunEvent.parse({
    schemaVersion: '0.1',
    eventId: `event_${requestId}`,
    runId: 'run_chat',
    runSeq,
    recordedAt: '2026-11-09T00:00:00.000Z',
    actor: { kind: 'runtime', id: 'runtime' },
    causedByEventIds: [],
    type: 'user_input.requested',
    payload: {
      requestId,
      executionId: `exec_${requestId}`,
      attemptNo: 1,
      bodyRef: `body_${requestId}`,
      schemaHash: 'b'.repeat(64),
      deadline: '2026-11-09T00:01:00.000Z',
    },
  }) as Extract<WaitingQuestion, { kind: 'question' }>['event'],
});

const body = (prompt: string) =>
  JSON.stringify({ key: 'layout', questions: [{ id: 'layout', kind: 'text', prompt }] });

/** The hook as the chat widgets use it: the run's texts, and a stable loader that fills them. */
async function show(questions: WaitingQuestion[], initial: Record<string, string>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const loads: string[] = [];
  let setTexts: (texts: Record<string, string>) => void = () => {};
  const load = async (bodyRef: string) => {
    loads.push(bodyRef);
  };
  function Notice() {
    const [texts, set] = useState(initial);
    setTexts = set;
    return <p>{useQuestionNotice(questions, texts, load) ?? ''}</p>;
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <Notice />
      </IntlProvider>,
    ),
  );
  return {
    text: () => container.textContent,
    loads,
    fill: (texts: Record<string, string>) => act(async () => setTexts(texts)),
  };
}

it('names the first waiting question in its own words, without a count for one', async () => {
  const notice = await show([question('q_1', 1)], {
    body_q_1: body('Which layout should I keep?'),
  });
  expect(notice.text()).toBe('Question: Which layout should I keep?');
  expect(notice.text()).not.toContain(messages.Widgets.actionQuestion);
  // The text was already there: nothing is read again.
  expect(notice.loads).toEqual([]);
});

it('adds the count beside the first question and reads a body it does not have yet', async () => {
  const notice = await show([question('q_1', 1), question('q_2', 2)], {});
  // Until the question text is read, the caller keeps its generic wording.
  expect(notice.text()).toBe('');
  expect(notice.loads).toEqual(['body_q_1']);
  await notice.fill({ body_q_1: body(`Which layout should I keep? ${'x'.repeat(300)}`) });
  const text = notice.text() ?? '';
  expect(text).toContain('Which layout should I keep?');
  expect(text).toContain('2 waiting');
  // A long question is shortened in the notice; the response area keeps it whole.
  expect(text).not.toContain('x'.repeat(300));
});

/** A live conversation run waiting on one question, as the chat widgets describe it. */
const waitingOnQuestion = {
  sessionId: 'session_chat',
  runId: 'run_chat',
  runNumber: 1,
  live: true,
  viewed: null,
  readState: 'ready',
  chips: [],
  tools: [],
  action: {
    visible: true,
    needsUser: true,
    hasFailure: false,
    completedWithFailures: false,
    count: 1,
    summary: 'question',
    unclearCauses: [],
  },
  questionNotice: 'Question: Which layout should I keep?',
  context: presentContext({ calls: [], compactions: [], selectedExecutionId: null }),
  failedExecutionId: null,
  activity: null,
  plan: {
    open: false,
    setOpen: vi.fn(),
    status: { state: 'hidden' },
    selectedKey: null,
    selectedChoice: null,
    choices: [],
    multiple: false,
    auto: true,
    runStatus: 'awaiting_user',
    retry: vi.fn(),
    follow: vi.fn(),
    choose: vi.fn(),
  },
} as unknown as ChatWidgetModel;

/** The composer's activity bar on a session screen whose conversation holds the needed-now tray. */
async function dock(tray: PendingTrayStore) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Reduced motion: the bar's words swap at once, with nothing left fading out.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduced-motion'),
    media: query,
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
  Element.prototype.getAnimations ??= () => [];
  fixture.model = waitingOnQuestion;
  const respond = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <PendingTrayContext.Provider value={{ store: tray, respond }}>
          <ComposerActivity
            sessionId="session_chat"
            ownActive={null}
            target={null}
            targets={[]}
            onJoin={vi.fn()}
            onStop={vi.fn()}
            onPause={vi.fn()}
            onResume={vi.fn()}
            viewingOther={false}
          />
        </PendingTrayContext.Provider>
      </IntlProvider>,
    ),
  );
  const bar = () => container.querySelector<HTMLElement>('[data-testid="activity-bar"]');
  return {
    // The bar's line while it tells what waits; otherwise no notice.
    notice: () => (bar()?.dataset.line === 'waiting' ? bar() : null),
    bar,
    respond,
  };
}

it('says the waiting question on the activity bar only once the tray is measured out of view', async () => {
  const tray = createPendingTrayStore();
  tray.setState({ waiting: 1 });
  const view = await dock(tray);
  // Not measured yet (the tray is still appearing): no notice, so none can flash.
  expect(tray.getState().placement).toBe('unknown');
  expect(view.notice()).toBeNull();
  // Measured in view: the tray's card says it, once.
  await act(async () => tray.setState({ placement: 'in-view' }));
  expect(view.notice()).toBeNull();
  // Scrolled away or under the composer: the notice says what waits.
  await act(async () => tray.setState({ placement: 'out-of-view' }));
  expect(view.notice()?.textContent).toContain('Question: Which layout should I keep?');
  // Gone again (nothing waits there, or another conversation): not known, so no notice.
  await act(async () => tray.setState({ placement: 'unknown' }));
  expect(view.notice()).toBeNull();
  // The bar itself keeps its place all along.
  expect(view.bar()).not.toBeNull();
});

// The screen's respond brings the tray into view and focuses it (PendingTray.test.tsx).
it('sends Respond to the conversation’s tray, not to the run record', async () => {
  const tray = createPendingTrayStore();
  tray.setState({ waiting: 1, placement: 'out-of-view' });
  const view = await dock(tray);
  const respond = [...(view.notice()?.querySelectorAll('button') ?? [])].find(
    (button) => button.textContent === messages.Activity.view,
  );
  expect(respond).toBeDefined();
  // Not a way to the run record: the conversation's tray answers it.
  expect(view.notice()?.querySelector('a')).toBeNull();
  await act(async () => respond?.click());
  expect(view.respond).toHaveBeenCalledTimes(1);
});
