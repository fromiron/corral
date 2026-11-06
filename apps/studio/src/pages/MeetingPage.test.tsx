// @vitest-environment jsdom
import type { MeetingRoundRequest, MeetingView } from '@corral/contracts';
import { createTextAttachment, type WorkSession } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const translate = vi.hoisted(() => (key: string) => key);
const services = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const liveAnswer = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('use-intl', () => ({
  useTranslations: () => translate,
  useFormatter: () => ({ dateTime: () => 'local-date' }),
}));
vi.mock('../services.tsx', () => ({ useServices: () => services.current }));
vi.mock('../workbench/useModels.ts', () => ({ useModelProfiles: () => null }));
vi.mock('../workbench/useCorralChat.ts', () => ({
  useCorralRun: () => ({ state: { projection: null, streams: {}, ...liveAnswer.current } }),
}));
vi.mock('../workbench/MeetingEvidence.tsx', () => ({
  MeetingEvidencePicker: ({ value, onChange }: any) => (
    <button
      type="button"
      onClick={() =>
        onChange([...value, createTextAttachment('brief.txt', 'text/plain', 'Selected evidence')])
      }
    >
      attachEvidence
    </button>
  ),
}));
vi.mock('../workbench/ChatView.tsx', () => ({
  ChatDensityMenu: () => null,
  ChatView: ({ items, composer, header, children }: any) => (
    <div>
      {header}
      {children}
      {items.map((item: any) => (
        <div key={item.id} data-chat-item={item.id}>
          {item.content}
        </div>
      ))}
      {composer}
    </div>
  ),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: any) => <a href="#run">{children}</a>,
  useRouter: () => ({ invalidate: async () => {} }),
}));
vi.mock('@corral/react', () => ({
  SafeMarkdown: ({ text }: any) => <p>{text}</p>,
  FailureNotice: ({ message }: any) => <p data-testid="provider-failure">{message}</p>,
}));
vi.mock('@corral/react/design-kit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@corral/react/design-kit')>()),
  Button: ({ children, variant: _v, size: _s, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
}));

const { MeetingPage } = await import('./MeetingPage.tsx');
const { preferences } = await import('../workbench/preferences.ts');

const config = {
  version: 1 as const,
  participants: [
    { participantId: 'p1', name: 'Architect', prompt: 'Structure.', modelProfile: 'model-a' },
    { participantId: 'p2', name: 'Builder', prompt: 'Delivery.', modelProfile: 'model-b' },
  ],
  secretary: { modelProfile: 'model-a' },
};
const answer = (participantId: string, status: 'running' | 'answered' | 'failed') => ({
  participantId,
  runId: `run_${participantId}`,
  status,
  text: status === 'answered' ? `${participantId} says yes` : null,
  detail: status === 'failed' ? 'provider unavailable' : null,
  usage: { modelCalls: 1, outputTokens: 12, unknown: status === 'failed' },
});
function view(change: Partial<MeetingView> = {}): MeetingView {
  return {
    sessionId: 'session_1',
    revision: 2,
    config,
    rounds: [
      {
        roundId: 'round_1',
        commandId: 'c1',
        kind: 'all',
        message: 'Ship it?',
        basedOnRoundId: null,
        rebuttalNo: null,
        participantIds: ['p1', 'p2'],
        createdAt: 'x',
        stoppedAt: null,
        active: false,
        answers: [answer('p1', 'answered'), answer('p2', 'failed')],
      },
    ],
    queued: null,
    rebuttal: { basedOnRoundId: 'round_1', rebuttalNo: 1 },
    ...change,
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  preferences.setState({ chatDensity: 'basic', sendKey: 'enter' });
  liveAnswer.current = {};
  localStorage.clear();
});

async function mount(current: MeetingView, sessionChange: Partial<WorkSession> = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const meetings = {
    view: vi.fn(async () => current),
    send: vi.fn(async (_sessionId: string, _request: MeetingRoundRequest) => ({
      ok: true,
      outcome: 'started',
    })),
    stop: vi.fn(async () => ({ ok: true, outcome: 'updated' })),
    sendQueued: vi.fn(async () => ({ ok: true, outcome: 'started' })),
    dropQueued: vi.fn(async () => ({ ok: true, outcome: 'updated' })),
    editQueued: vi.fn(async () => ({ ok: true, outcome: 'updated' })),
  };
  services.current = {
    meetings,
    mode: 'browser',
    live: false,
    repository: {
      getSession: vi.fn(async () => ({ revision: current.revision })),
      updateSession: vi.fn(async () => ({ ok: true })),
    },
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const session = {
    sessionId: current.sessionId,
    title: 'Review',
    revision: 3,
    ...sessionChange,
  } as WorkSession;
  await act(async () => root.render(<MeetingPage session={session} />));
  const button = (text: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  const box = container.querySelector('textarea')!;
  const type = async (text: string) =>
    act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
  return {
    container,
    meetings,
    button,
    box,
    type,
    hide: () => act(async () => root.render(null)),
    show: () =>
      act(async () => {
        services.current = { meetings, mode: 'browser', live: false };
        root.render(<MeetingPage session={session} />);
      }),
  };
}

it('shows each answer in participant order and sends a conversational follow-up with mentions', async () => {
  const f = await mount(view());
  const articles = [...f.container.querySelectorAll('article')].map((a) =>
    a.getAttribute('aria-label'),
  );
  expect(articles).toEqual(['Architect', 'Builder']);
  expect(f.container.textContent).toContain('p1 says yes');
  expect(f.container.textContent).toContain('status.failed');
  expect(f.container.textContent).toContain('provider unavailable');
  expect(f.container.textContent).not.toContain('usageUnknown');
  await act(async () => f.button('@Builder')?.click());
  expect(f.button('@Builder')?.getAttribute('aria-pressed')).toBe('true');
  // The secretary is called on its own.
  await act(async () => f.button('@secretary')?.click());
  expect(f.button('@Builder')?.getAttribute('aria-pressed')).toBe('false');
  await act(async () => f.button('@Builder')?.click());
  await f.type('What would it cost?');
  await act(async () => f.button('send')?.click());
  expect(f.meetings.send).toHaveBeenCalledExactlyOnceWith(
    'session_1',
    expect.objectContaining({ kind: 'message', text: 'What would it cost?', mentions: ['p2'] }),
  );
  expect(f.button('rebuttal')).toBeUndefined();
  await f.type('Why do you think that?');
  await act(async () => f.button('send')?.click());
  expect(f.meetings.send).toHaveBeenLastCalledWith(
    'session_1',
    expect.objectContaining({ kind: 'message', text: 'Why do you think that?' }),
  );
});

it('a participant waiting for its turn is shown without a failed response or Run link', async () => {
  const current = view();
  current.rounds[0]!.active = true;
  current.rounds[0]!.answers[0] = answer('p1', 'running');
  current.rounds[0]!.answers[1] = {
    ...answer('p2', 'running'),
    status: 'waiting',
    runId: null,
    usage: null,
  };
  const f = await mount(current);
  const waiting = f.container.querySelector('article[aria-label="Builder"]')!;
  expect(waiting.textContent).toContain('status.waiting');
  expect(waiting.querySelector('.text-danger')).toBeNull();
  expect(waiting.querySelector('a')).toBeNull();
});

it('exposes individual chat messages without a work panel or round controls', async () => {
  const f = await mount(view());
  const items = [...f.container.querySelectorAll('[data-chat-item]')];
  expect(items).toHaveLength(3);
  expect(items[0]?.textContent).toContain('Ship it?');
  expect(items[1]?.textContent).toContain('p1 says yes');
  expect(items[2]?.textContent).toContain('provider unavailable');
  expect(f.container.querySelector('details[aria-label="records"]')).toBeNull();
  expect(f.button('rebuttal')).toBeUndefined();
  expect(f.container.textContent).not.toContain('noLimits');
  expect(f.container.textContent).not.toContain('openRun');
  await act(async () => preferences.setState({ chatDensity: 'detailed' }));
  expect(f.container.textContent).toContain('openRun');
  expect(f.container.textContent).toContain('usageUnknown');
});

it('shows in-progress model text before the completed answer arrives', async () => {
  liveAnswer.current = {
    projection: { modelCalls: { call_1: { finished: false } } },
    streams: { call_1: { text: 'I would choose kimchi stew', broken: false, completed: false } },
  };
  const f = await mount(
    view({ rounds: [{ ...view().rounds[0]!, active: true, answers: [answer('p1', 'running')] }] }),
  );
  expect(f.container.textContent).toContain('I would choose kimchi stew');
  expect(f.container.textContent).toContain('status.running');
});

it('does not present a broken stream as a complete answer', async () => {
  liveAnswer.current = {
    projection: { modelCalls: { call_1: { finished: false } } },
    streams: { call_1: { text: 'Missing a middle chunk', broken: true, completed: false } },
  };
  const f = await mount(
    view({ rounds: [{ ...view().rounds[0]!, active: true, answers: [answer('p1', 'running')] }] }),
  );
  expect(f.container.textContent).not.toContain('Missing a middle chunk');
});

it('only shows stream text associated with the current answer run', async () => {
  liveAnswer.current = {
    projection: { modelCalls: {} },
    streams: { old_call: { text: 'Another run response', broken: false, completed: false } },
  };
  const f = await mount(
    view({ rounds: [{ ...view().rounds[0]!, active: true, answers: [answer('p1', 'running')] }] }),
  );
  expect(f.container.textContent).not.toContain('Another run response');
});

it('interleaved human messages and agent mentions display in their posted order', async () => {
  const first = view().rounds[0]!;
  const f = await mount(
    view({
      rounds: [
        {
          ...first,
          order: 0,
          answers: [
            { ...answer('p1', 'answered'), order: 1 },
            { ...answer('p2', 'answered'), order: 4 },
          ],
        },
        {
          ...first,
          roundId: 'mention',
          message: null,
          replyTo: { roundId: first.roundId, participantId: 'p1' },
          order: 2,
          answers: [{ ...answer('p1', 'answered'), text: 'Tagged reply', order: 3 }],
        },
      ],
    }),
  );
  expect(
    [...f.container.querySelectorAll('[data-chat-item]')].map((item) =>
      item.getAttribute('data-chat-item'),
    ),
  ).toEqual(['round_1:message', 'round_1:p1', 'mention:p1', 'round_1:p2']);
});

it('typing while a send receipt is pending preserves the next draft', async () => {
  const f = await mount(view());
  let finish!: (result: any) => void;
  f.meetings.send.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await f.type('First');
  await act(async () => f.button('send')?.click());
  expect(f.box.disabled).toBe(false);
  await f.type('Second');
  await act(async () => finish({ ok: true, outcome: 'started' }));
  expect(f.box.value).toBe('Second');
  await act(async () => f.button('send')?.click());
  expect(f.meetings.send).toHaveBeenLastCalledWith(
    'session_1',
    expect.objectContaining({ text: 'Second' }),
  );
});

it('Enter while composing with an IME does not send, and a lost answer keeps its command ID', async () => {
  const f = await mount(view());
  await f.type('한글 입력');
  await act(async () => {
    f.box.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
    );
  });
  expect(f.meetings.send).not.toHaveBeenCalled();
  f.meetings.send.mockRejectedValueOnce(new Error('connection lost'));
  await act(async () => f.button('send')?.click());
  await act(async () => f.button('send')?.click());
  const [first, second] = f.meetings.send.mock.calls.map(
    (call) => call[1] as { commandId: string },
  );
  expect(second?.commandId).toBe(first?.commandId);
});

it('a running round can be stopped and a waiting message is shown, sendable only when idle', async () => {
  const running = view({
    rounds: [
      {
        ...view().rounds[0]!,
        active: true,
        answers: [answer('p1', 'running'), answer('p2', 'running')],
      },
    ],
    queued: { commandId: 'q', mode: 'mock', text: 'next question', mentions: [] },
    rebuttal: null,
  });
  const f = await mount(running);
  expect(f.button('rebuttal')).toBeUndefined();
  expect(f.button('sendQueued')).toBeUndefined();
  expect(f.container.textContent).toContain('next question');
  await act(async () => f.button('stopRound')?.click());
  expect(f.meetings.stop).toHaveBeenCalledWith('session_1', 'round_1');
  await act(async () => f.button('dropQueued')?.click());
  expect(f.meetings.dropQueued).toHaveBeenCalledWith('session_1');
});

it('/반론 is sent to the round service and an uncertain retry keeps its command ID', async () => {
  const f = await mount(view());
  await f.type('/반론');
  f.meetings.send.mockRejectedValueOnce(new Error('connection lost'));
  await act(async () => f.button('send')?.click());
  expect(f.container.querySelector('[role="alert"]')?.textContent).toBe('connection lost');
  await act(async () => f.button('send')?.click());
  const requests = f.meetings.send.mock.calls.map((call) => call[1] as any);
  expect(requests[0]?.text).toBe('/반론');
  expect(requests[1]?.commandId).toBe(requests[0]?.commandId);
});

it('active replies and a legacy draft never block new messages; editing preserves that draft identity', async () => {
  const current = view({
    rounds: [{ ...view().rounds[0]!, active: true }],
    queued: { commandId: 'queued_1', mode: 'mock', text: 'First draft', mentions: ['p1'] },
    rebuttal: null,
  });
  const f = await mount(current);
  await f.type('Keep my next draft');
  await act(async () =>
    f.box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  expect(f.meetings.send).toHaveBeenCalledWith(
    'session_1',
    expect.objectContaining({ text: 'Keep my next draft' }),
  );
  await f.type('Another message while models answer');
  await act(async () => f.button('send')?.click());
  expect(f.meetings.send).toHaveBeenCalledTimes(2);
  await f.type('Keep my next draft');
  expect(f.button('editQueued')).toBeDefined();
  await act(async () => f.button('editQueued')?.click());
  const queuedBox = f.container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="queued"]',
  )!;
  const queuedButton = (label: string) =>
    [
      ...queuedBox
        .closest('[data-slot="textarea-control"]')!
        .parentElement!.querySelectorAll('button'),
    ].find((item) => item.textContent?.trim() === label);
  expect(queuedButton('@Architect')).toBeDefined();
  await act(async () => queuedButton('@Architect')?.click());
  await act(async () => queuedButton('@Builder')?.click());
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      queuedBox,
      'Revised question',
    );
    queuedBox.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => f.button('saveQueued')?.click());
  expect(f.meetings.editQueued).toHaveBeenCalledExactlyOnceWith('session_1', {
    commandId: 'queued_1',
    mode: 'mock',
    text: 'Revised question',
    mentions: ['p2'],
  });
  expect(f.box.value).toBe('Keep my next draft');
});

it('a stopped round is identified even when completed answers are retained', async () => {
  const f = await mount(
    view({ rounds: [{ ...view().rounds[0]!, stoppedAt: '2026-10-23T00:00:00Z' }] }),
  );
  expect(f.container.textContent).toContain('roundStopped');
  expect(f.container.textContent).toContain('p1 says yes');
});

it('asking the secretary to summarise preserves the unsent draft', async () => {
  const f = await mount(view());
  await f.type('Do not erase this question');
  await act(async () => f.button('summarise')?.click());
  expect(f.box.value).toBe('Do not erase this question');
  expect(f.meetings.send).toHaveBeenCalledWith(
    'session_1',
    expect.objectContaining({ mentions: ['secretary'] }),
  );
});

it('only explicitly attached evidence is sent, and a failed send preserves it', async () => {
  const f = await mount(view());
  await act(async () => f.button('attachEvidence')?.click());
  await f.type('Review this evidence');
  f.meetings.send.mockRejectedValueOnce(new Error('connection lost'));
  await act(async () => f.button('send')?.click());
  await act(async () => f.button('send')?.click());
  const [first, second] = f.meetings.send.mock.calls.map((call) => call[1]);
  expect(first).toMatchObject({ attachments: [{ name: 'brief.txt', text: 'Selected evidence' }] });
  expect(second).toEqual(first);
  await f.type('Now without the evidence');
  await act(async () => f.button('send')?.click());
  expect(f.meetings.send.mock.calls.at(-1)?.[1]).not.toHaveProperty('attachments');
});

it('starts with a compact composer and keeps selected evidence reviewable', async () => {
  const f = await mount(view());
  const disclosure = f.container.querySelector<HTMLDetailsElement>(
    'details[aria-label="evidence"]',
  );
  expect(disclosure).not.toBeNull();
  expect(disclosure?.open).toBe(false);
  expect(f.button('attachEvidence')?.closest('details')).toBe(disclosure);
  expect(f.box.rows).toBe(2);
  await act(async () => disclosure!.querySelector('summary')!.click());
  expect(disclosure?.open).toBe(true);
  await act(async () => f.button('attachEvidence')?.click());
  expect(disclosure?.querySelector('summary')?.textContent).toBe('evidenceSelected');
  await f.type('Review this');
  f.meetings.send.mockRejectedValueOnce(new Error('connection lost'));
  await act(async () => f.button('send')?.click());
  expect(disclosure?.open).toBe(true);
  expect(disclosure?.querySelector('summary')?.textContent).toBe('evidenceSelected');
  await act(async () => f.button('send')?.click());
  expect(f.meetings.send.mock.calls.at(-1)?.[1]).toMatchObject({
    attachments: [{ name: 'brief.txt' }],
  });
  expect(disclosure?.querySelector('summary')?.textContent).toBe('evidence');
});

it('a late refresh cannot replace a newer round view', async () => {
  const current = view({ rounds: [{ ...view().rounds[0]!, active: true }] });
  const f = await mount(current);
  let finish: (value: MeetingView) => void = () => {};
  const delayed = new Promise<MeetingView>((resolve) => {
    finish = resolve;
  });
  f.meetings.view.mockReturnValueOnce(delayed);
  f.meetings.view.mockResolvedValueOnce(
    view({ revision: 3, rounds: [{ ...view().rounds[0]!, message: 'Latest question' }] }),
  );
  await act(async () => {
    f.button('stopRound')?.click();
  });
  await act(async () => f.button('stopRound')?.click());
  expect(f.container.textContent).toContain('Latest question');
  await act(async () => finish(current));
  expect(f.container.textContent).toContain('Latest question');
});

it('slow polling waits for the pending response before requesting another', async () => {
  vi.useFakeTimers();
  const f = await mount(view({ rounds: [{ ...view().rounds[0]!, active: true }] }));
  let finish: (value: MeetingView) => void = () => {};
  f.meetings.view.mockReturnValueOnce(
    new Promise<MeetingView>((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(f.meetings.view).toHaveBeenCalledTimes(2);
  await act(async () =>
    finish(
      view({ revision: 3, rounds: [{ ...view().rounds[0]!, message: 'Slow answer arrived' }] }),
    ),
  );
  expect(f.container.textContent).toContain('Slow answer arrived');
});

it('parsed secretary minutes open the records panel instead of displaying their storage JSON', async () => {
  const raw = '{"issues":["Meeting issue"],"claims":[],"candidates":[]}';
  const f = await mount(
    view({
      rounds: [
        {
          ...view().rounds[0]!,
          kind: 'secretary',
          participantIds: ['secretary'],
          answers: [{ ...answer('secretary', 'answered'), text: raw }],
        },
      ],
      minutes: [
        {
          minutesId: 'minutes_1',
          roundId: 'round_1',
          createdAt: 'x',
          error: null,
          document: {
            issues: ['Meeting issue'],
            claims: [],
            agreements: [],
            remainingDissent: [],
            unverifiedFacts: [],
            candidates: [],
          },
        },
      ],
    }),
  );
  expect(f.container.querySelector('article[aria-label="secretary"]')?.textContent).not.toContain(
    raw,
  );
  expect(f.button('viewMinutes')).toBeDefined();
  await act(async () => f.button('viewMinutes')?.click());
  expect(f.container.querySelector<HTMLDetailsElement>('details[aria-label="records"]')?.open).toBe(
    true,
  );
  expect(document.activeElement?.tagName).toBe('SUMMARY');
});

it('an unparsed secretary answer stays available for recovery', async () => {
  const f = await mount(
    view({
      rounds: [
        {
          ...view().rounds[0]!,
          kind: 'secretary',
          participantIds: ['secretary'],
          answers: [{ ...answer('secretary', 'answered'), text: 'Incomplete summary' }],
        },
      ],
      minutes: [
        {
          minutesId: 'minutes_1',
          roundId: 'round_1',
          createdAt: 'x',
          error: 'Invalid minutes',
          document: null,
        },
      ],
    }),
  );
  expect(f.container.querySelector('article[aria-label="secretary"]')?.textContent).toContain(
    'Incomplete summary',
  );
  expect(f.button('viewMinutes')).toBeUndefined();
});

it('keeps the meeting draft across navigation and remounts, isolated from other sessions', async () => {
  const f = await mount(view());
  await f.type('Keep this exact meeting draft.');
  await act(async () => f.button('@Builder')?.click());
  await act(async () => f.button('attachEvidence')?.click());
  await f.hide();
  const other = await mount(view({ sessionId: 'another_meeting' }));
  expect(other.box.value).toBe('');
  await other.type('Another draft');
  await other.hide();
  await f.show();
  expect(f.container.querySelector('textarea')?.value).toBe('Keep this exact meeting draft.');
  expect(f.button('@Builder')?.getAttribute('aria-pressed')).toBe('true');
  expect(f.container.textContent).toContain('evidenceSelected');
  await act(async () => f.button('clearDraft')?.click());
  expect(f.container.querySelector('textarea')?.value).toBe('');
  await f.hide();
  await f.show();
  expect(f.container.querySelector('textarea')?.value).toBe('');
});

it('clears only a successfully sent draft and preserves edits made while sending', async () => {
  const f = await mount(view());
  await f.type('First request');
  f.meetings.send.mockRejectedValueOnce(new Error('offline'));
  await act(async () => f.button('send')?.click());
  await f.hide();
  await f.show();
  expect(f.container.querySelector('textarea')?.value).toBe('First request');
  let finish: (value: { ok: boolean; outcome: string }) => void = () => {};
  f.meetings.send.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await act(async () => {
    f.button('send')?.click();
  });
  const box = f.container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      box,
      'Next request',
    );
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => finish({ ok: true, outcome: 'started' }));
  await f.hide();
  await f.show();
  expect(f.container.querySelector('textarea')?.value).toBe('Next request');
  await act(async () => f.button('send')?.click());
  await f.hide();
  await f.show();
  expect(f.container.querySelector('textarea')?.value).toBe('');
});

it('keeps only the latest minutes error visible outside the collapsed panel with recovery', async () => {
  const f = await mount(
    view({
      minutes: [
        {
          minutesId: 'old',
          roundId: 'round_1',
          createdAt: 'a',
          document: null,
          error: 'Old failure',
        },
        {
          minutesId: 'new',
          roundId: 'round_1',
          createdAt: 'b',
          document: null,
          error: 'Latest failure',
        },
      ],
    }),
  );
  const alerts = [...f.container.querySelectorAll('[role="alert"]')];
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.closest('details')).toBeNull();
  expect(f.container.textContent).not.toContain('Old failure');
  expect(f.button('retrySummary')).toBeDefined();
  await act(async () => f.button('retrySummary')?.click());
  expect(f.meetings.send.mock.calls.at(-1)?.[1]).toMatchObject({
    kind: 'message',
    mentions: ['secretary'],
  });
  expect(f.container.textContent).toContain('handoffNeedsMinutes');
});

it('uses the chosen send key and preserves IME confirmation keys', async () => {
  preferences.setState({ sendKey: 'mod-enter' });
  const f = await mount(view());
  await f.type('Do not send on plain Enter');
  const press = async (init: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      ...init,
    });
    await act(async () => {
      f.box.dispatchEvent(event);
    });
    return event.defaultPrevented;
  };
  expect(await press({})).toBe(false);
  expect(f.meetings.send).not.toHaveBeenCalled();
  expect(await press({ ctrlKey: true, isComposing: true })).toBe(false);
  expect(await press({ ctrlKey: true, keyCode: 229 })).toBe(false);
  expect(f.meetings.send).not.toHaveBeenCalled();
  expect(await press({ ctrlKey: true })).toBe(true);
  expect(f.meetings.send).toHaveBeenCalledTimes(1);
  await f.type('Send on Command Enter');
  expect(await press({ metaKey: true })).toBe(true);
  expect(f.meetings.send).toHaveBeenCalledTimes(2);
  preferences.setState({ sendKey: 'enter' });
  await f.type('Keep shift Enter as a newline');
  expect(await press({ shiftKey: true })).toBe(false);
  expect(await press({ altKey: true })).toBe(false);
  expect(await press({})).toBe(true);
  expect(f.meetings.send).toHaveBeenCalledTimes(3);
});

it('restores an archived meeting from its notice or registered command without changing its draft', async () => {
  const { registeredCommands } = await import('../commandRegistry.ts');
  const f = await mount(view({ revision: 9 }), { archivedAt: '2026-10-28T00:00:00Z' });
  await f.type('Archived draft');
  expect(f.container.textContent).toContain('archivedSending');
  await act(async () => f.button('restoreSession')?.click());
  const repository = services.current.repository as any;
  expect(repository.updateSession).toHaveBeenCalledWith('session_1', {
    archived: false,
    expectedRevision: 9,
  });
  const restore = registeredCommands().find((command) => command.id === 'session:archive');
  expect(restore?.title).toBe('restore');
  await act(async () => restore?.run());
  expect(repository.updateSession).toHaveBeenCalledTimes(2);
  expect(f.box.value).toBe('Archived draft');
});

it('shows a readable failed-answer reason and keeps technical details collapsed and copyable', async () => {
  const round = view().rounds[0];
  if (!round) throw new Error('The meeting fixture needs a round');
  const f = await mount(
    view({
      rounds: [
        {
          ...round,
          answers: [{ ...answer('p2', 'failed'), detail: 'HTTP 500: provider unavailable' }],
        },
      ],
    }),
  );
  expect(f.container.textContent).toContain('requestFailed');
  const diagnostic = f.container.querySelector<HTMLDetailsElement>('article details');
  expect(diagnostic?.open).toBe(false);
  expect(diagnostic?.textContent).toContain('HTTP 500: provider unavailable');
  expect(diagnostic?.querySelector('button')?.textContent).toBe('copyDiagnostics');
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  await act(async () => diagnostic?.querySelector('button')?.click());
  expect(writeText).toHaveBeenCalledWith('HTTP 500: provider unavailable');
  expect(diagnostic?.querySelector('button')?.textContent).toBe('diagnosticsCopied');
});

it('does not update an archived meeting that disappeared before the restore click', async () => {
  const f = await mount(view(), { archivedAt: '2026-10-28T00:00:00Z' });
  const repository = services.current.repository as any;
  repository.getSession.mockResolvedValueOnce(null);
  await act(async () => f.button('restoreSession')?.click());
  expect(repository.updateSession).not.toHaveBeenCalled();
  expect(f.container.textContent).toContain('notFound');
});

it('lets readers expand the records area without losing the message composer', async () => {
  const f = await mount(
    view({
      minutes: [
        {
          minutesId: 'm1',
          roundId: 'round_1',
          createdAt: 'x',
          error: null,
          document: {
            issues: ['A long record'],
            claims: [],
            agreements: [],
            remainingDissent: [],
            unverifiedFacts: [],
            candidates: [],
          },
        },
      ],
    }),
  );
  const records = f.container.querySelector<HTMLDetailsElement>('details[aria-label="records"]')!;
  records.open = true;
  expect(f.button('expandRecords')?.getAttribute('aria-pressed')).toBe('false');
  await act(async () => f.button('expandRecords')?.click());
  expect(f.button('compactRecords')?.getAttribute('aria-pressed')).toBe('true');
  expect(records.querySelector('.overflow-y-auto')).toBeNull();
  expect(f.box.isConnected).toBe(true);
  await act(async () => f.button('compactRecords')?.click());
  expect(records.querySelector('.overflow-y-auto')).not.toBeNull();
});

it('uses the shared recovery explanation for recorded provider failures', async () => {
  const f = await mount(
    view({
      rounds: [
        {
          ...view().rounds[0]!,
          answers: [
            { ...answer('p2', 'failed'), detail: 'the model request failed: HTTP 401 (AUTH)' },
          ],
        },
      ],
    }),
  );
  expect(f.container.querySelector('[data-testid="provider-failure"]')?.textContent).toContain(
    'HTTP 401 (AUTH)',
  );
});
