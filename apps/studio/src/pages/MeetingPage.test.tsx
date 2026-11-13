// @vitest-environment jsdom
import type { MeetingRoundRequest, MeetingView } from '@corral/contracts';
import { createTextAttachment, type WorkSession } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  // The real view hides its timeline while a long header (the widened records) is read.
  ChatView: ({ items, composer, header, children, expandedHeader, sent }: any) => (
    <div data-sent={sent}>
      {header}
      <section data-testid="chat-timeline" hidden={expandedHeader}>
        {children}
        {items.map((item: any) => (
          <div key={item.id} data-chat-item={item.id}>
            {item.content}
          </div>
        ))}
      </section>
      <div data-testid="chat-composer">{composer}</div>
    </div>
  ),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: any) => <a href="#run">{children}</a>,
  useRouter: () => ({ invalidate: async () => {} }),
}));
vi.mock('@corral/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@corral/react')>()),
  SafeMarkdown: ({ text }: any) => <p>{text}</p>,
  FailureNotice: ({ message }: any) => <p data-testid="provider-failure">{message}</p>,
  CopyTextButton: ({ text }: any) => (
    <button type="button" aria-label="copyMessage" data-copy={text} />
  ),
}));
vi.mock('@corral/react/design-kit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@corral/react/design-kit')>()),
  Button: ({ children, variant: _v, size: _s, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
}));

const { MeetingPage } = await import('./MeetingPage.tsx');
const { writeComposerDraft } = await import('../workbench/sessionDraft.ts');
const { preferences } = await import('../workbench/preferences.ts');
const { TopbarSlotContext } = await import('../workbench/TopbarSlot.tsx');
const { registeredCommands } = await import('../commandRegistry.ts');
const { meetingDecisionEdits } = await import('../workbench/MeetingDecisions.tsx');

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

/** The minutes, decisions and handoff: the side panel, or the drawer on a narrow screen. */
const records = () => document.body.querySelector<HTMLElement>('[data-meeting-records]');
const timeline = () => document.body.querySelector<HTMLElement>('[data-testid="chat-timeline"]');
const participant = (id: string) =>
  document.body.querySelector<HTMLElement>(
    `[aria-label="participants"] [data-participant="${id}"]`,
  );
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Missing ${what}`);
  return value;
}
const firstRound = () => must(view().rounds[0], 'the fixture round');
/** Types into a field the way React hears it. */
async function fill(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const minutesWithCandidate = {
  minutesId: 'minutes_1',
  roundId: 'round_1',
  createdAt: 'x',
  error: null,
  document: {
    issues: ['Whether to ship'],
    claims: [],
    agreements: [],
    remainingDissent: [],
    unverifiedFacts: [],
    candidates: [
      {
        candidateId: 'ship',
        content: {
          goal: 'Ship the change',
          scope: [],
          excludedScope: [],
          acceptanceCriteria: [],
          remainingDissent: [],
          evidence: [],
          risks: [],
          actions: [],
          rejectedAlternatives: [],
        },
      },
    ],
  },
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  preferences.setState({ chatDensity: 'basic', sendKey: 'enter' });
  liveAnswer.current = {};
  localStorage.clear();
  meetingDecisionEdits.setState({}, true);
});

async function mount(
  current: MeetingView,
  sessionChange: Partial<WorkSession> = {},
  { narrow = false, compact = false }: { narrow?: boolean; compact?: boolean } = {},
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Under 1024px the records open as a drawer over the conversation; `resize` crosses it.
  const screen = { narrow };
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      if (query === '(max-width: 639px)') return compact;
      return query === '(max-width: 1023px)' ? screen.narrow : false;
    },
    media: query,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  });
  cleanups.push(async () => {
    if (animations) Object.defineProperty(Element.prototype, 'getAnimations', animations);
    else Reflect.deleteProperty(Element.prototype, 'getAnimations');
  });
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
  // The page's toolbar portals into the top bar, which sits beside the page.
  const container = document.createElement('div');
  const toolbar = document.createElement('div');
  const page = document.createElement('div');
  container.append(toolbar, page);
  document.body.append(container);
  const root = createRoot(page);
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
  const render = () =>
    root.render(
      <TopbarSlotContext.Provider value={{ actions: toolbar, views: null, crumbs: null }}>
        <MeetingPage session={session} />
      </TopbarSlotContext.Provider>,
    );
  await act(async () => render());
  // Icon buttons (the kit's send arrow, the records toggle) are named by their label.
  const button = (text: string) =>
    [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text || b.getAttribute('aria-label') === text,
    );
  const box = container.querySelector('textarea')!;
  const type = async (text: string) =>
    act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
  /** The tool line's target badge, which in a meeting chooses the recipients. */
  const recipients = (scope: ParentNode = container) =>
    scope.querySelector<HTMLElement>('[data-slot="composer-target"]');
  const recipientItem = (label: string) =>
    [
      ...document.body.querySelectorAll<HTMLElement>(
        '[role="menuitemradio"], [role="menuitemcheckbox"]',
      ),
    ].find((entry) => entry.getAttribute('aria-label') === label);
  /** Picks a recipient in the badge's menu, opening it first if it is closed. */
  const chooseRecipient = async (label: string, scope: ParentNode = container) => {
    if (!document.body.querySelector('[role="menu"]'))
      await act(async () => recipients(scope)?.click());
    let item: HTMLElement | undefined;
    await vi.waitFor(() => {
      item = recipientItem(label);
      expect(item).toBeDefined();
    });
    const closes = item?.getAttribute('role') === 'menuitemradio';
    await act(async () => item?.click());
    // Auto and No one close the menu: it has left before the next pick opens it again.
    if (closes)
      await vi.waitFor(() => expect(document.body.querySelector('[role="menu"]')).toBeNull());
  };
  const closeMenu = async () => {
    const menu = document.body.querySelector('[role="menu"]');
    if (!menu) return;
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await vi.waitFor(() => expect(document.body.querySelector('[role="menu"]')).toBeNull());
  };
  /** Presses a key in the box; whether the page took it. */
  const press = async (init: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      ...init,
    });
    await act(async () => {
      box.dispatchEvent(event);
    });
    return event.defaultPrevented;
  };
  /** Opens the composer's add menu and chooses Attach evidence. */
  const openEvidence = async () => {
    await act(async () => button('attachmentActions')?.click());
    let item: HTMLElement | undefined;
    await vi.waitFor(() => {
      item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (entry) => entry.getAttribute('aria-label') === 'evidence',
      );
      expect(item).toBeDefined();
    });
    await act(async () => item?.click());
  };
  return {
    container,
    meetings,
    button,
    box,
    type,
    recipients,
    recipientItem,
    chooseRecipient,
    closeMenu,
    press,
    openEvidence,
    resize: (next: { narrow: boolean }) =>
      act(async () => {
        screen.narrow = next.narrow;
        for (const listener of listeners) listener();
      }),
    hide: () => act(async () => root.render(null)),
    show: () =>
      act(async () => {
        services.current = { meetings, mode: 'browser', live: false };
        render();
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
  await f.chooseRecipient('Builder');
  expect(f.recipientItem('Builder')?.getAttribute('aria-checked')).toBe('true');
  // The secretary is called on its own.
  await f.chooseRecipient('secretary');
  expect(f.recipientItem('Builder')?.getAttribute('aria-checked')).toBe('false');
  await f.chooseRecipient('Builder');
  expect(f.recipientItem('secretary')?.getAttribute('aria-checked')).toBe('false');
  await f.closeMenu();
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

it('a participant waiting for its turn has no row in the timeline: the activity bar says it', async () => {
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
  expect(f.container.querySelector('article[aria-label="Builder"]')).toBeNull();
  expect(f.container.querySelector('[data-chat-item="round_1:p2"]')).toBeNull();
  // The running answer's row is there; the bar counts the one waiting.
  expect(f.container.querySelector('article[aria-label="Architect"]')).not.toBeNull();
  expect(f.container.querySelector('[data-activity-bar]')?.textContent).toContain(
    'activity.waiting',
  );
});

it('exposes individual chat messages without a work panel or round controls', async () => {
  const f = await mount(view());
  const items = [...f.container.querySelectorAll('[data-chat-item]')];
  expect(items).toHaveLength(3);
  expect(items[0]?.textContent).toContain('Ship it?');
  expect(items[1]?.textContent).toContain('p1 says yes');
  expect(items[2]?.textContent).toContain('provider unavailable');
  expect(f.container.querySelector('details[aria-label="records"]')).toBeNull();
  expect(records()).toBeNull();
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
  // The conversation's queue line: the waiting message is a card of the kit's queue stack.
  expect(f.button('removeQueuedMessage')).toBeDefined();
  expect(f.button('editQueuedMessage')).toBeDefined();
  await act(async () => f.button('removeQueuedMessage')?.click());
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
  expect(f.button('editQueuedMessage')).toBeDefined();
  await act(async () => f.button('editQueuedMessage')?.click());
  const queuedBox = f.container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="queued"]',
  )!;
  // The waiting message chooses its recipients with the same badge as the composer.
  const queuedEditor = queuedBox.closest('[data-slot="textarea-control"]')!.parentElement!;
  expect(f.recipients(queuedEditor)?.textContent).toContain('Architect');
  await f.chooseRecipient('Architect', queuedEditor);
  await f.chooseRecipient('Builder', queuedEditor);
  await f.closeMenu();
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
  await f.openEvidence();
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

it('starts with a compact composer; evidence is attached from its add menu and stays in view', async () => {
  const f = await mount(view());
  const composer = must(
    f.container.querySelector<HTMLElement>('[data-testid="chat-composer"]'),
    'the composer',
  );
  const chosen = () => composer.querySelector('[aria-label="evidenceSelected"]');
  // The conversation's composer, at its height: one row until the text grows.
  expect(composer.querySelector('[data-slot="composer-shell"]')).not.toBeNull();
  expect(f.box.rows).toBe(1);
  // The picker is not laid out in the composer; the add menu opens it.
  expect(f.button('attachEvidence')).toBeUndefined();
  expect(composer.querySelector('details')).toBeNull();
  expect(chosen()).toBeNull();
  await f.openEvidence();
  // The same handler as before: the picker's choice becomes the message's evidence.
  await act(async () => f.button('attachEvidence')?.click());
  expect(chosen()?.textContent).toContain('brief.txt');
  await f.type('Review this');
  f.meetings.send.mockRejectedValueOnce(new Error('connection lost'));
  await act(async () => f.button('send')?.click());
  expect(chosen()?.textContent).toContain('brief.txt');
  await act(async () => f.button('send')?.click());
  expect(f.meetings.send.mock.calls.at(-1)?.[1]).toMatchObject({
    attachments: [{ name: 'brief.txt' }],
  });
  expect(chosen()).toBeNull();
  // A chosen item can be taken off before sending.
  await f.openEvidence();
  await act(async () => f.button('attachEvidence')?.click());
  await act(async () => f.button('removeEvidence')?.click());
  expect(chosen()).toBeNull();
});

it('names the reviewed minutes once, where the secretary posted them, and not in the composer', async () => {
  const f = await mount(
    view({
      rounds: [
        firstRound(),
        {
          ...firstRound(),
          roundId: 'round_2',
          commandId: 'c2',
          kind: 'secretary',
          message: 'summaryRequest',
          participantIds: ['secretary'],
          answers: [{ ...answer('secretary', 'answered'), text: '{}' }],
        },
      ],
      minutes: [{ ...minutesWithCandidate, roundId: 'round_2' }],
    }),
  );
  const reviews = [...document.body.querySelectorAll('button')].filter(
    (item) => item.textContent?.trim() === 'viewMinutes',
  );
  expect(reviews).toHaveLength(1);
  expect(reviews[0]?.closest('[data-chat-item]')?.getAttribute('data-chat-item')).toBe(
    'round_2:secretary',
  );
  // The button under the secretary's name says it; no sentence above it says it again.
  expect(reviews[0]?.closest('[data-chat-item]')?.textContent).not.toContain('minutesReady');
  const composer = must(
    f.container.querySelector<HTMLElement>('[data-testid="chat-composer"]'),
    'the composer',
  );
  // No prompt row restating the next step, and the recipients' rule is not a visible sentence.
  expect(composer.textContent).not.toContain('handoffNeeds');
  expect([...composer.querySelectorAll('p')].some((p) => p.textContent === 'everyone')).toBe(false);
  // Asking the secretary for a plan stays one quiet action beside Send.
  expect(f.button('summarise')?.closest('[data-testid="chat-composer"]')).toBe(composer);
});

// features/advisor.md "두는 곳" (대화): the advisor is a conversation's setting; a meeting's composer
// draws no advisor control.
it('draws no advisor control in the meeting composer', async () => {
  const f = await mount(view());
  const composer = must(
    f.container.querySelector<HTMLElement>('[data-testid="chat-composer"]'),
    'the composer',
  );
  expect(composer.querySelector('[data-slot="composer-shell"]')).not.toBeNull();
  expect(document.querySelector('[data-slot="composer-advisor"]')).toBeNull();
});

it('reads an answer as prose under its participant, and the person’s message as a sent bubble', async () => {
  const f = await mount(view());
  const architect = must(
    f.container.querySelector<HTMLElement>('article[aria-label="Architect"]'),
    'the answer',
  );
  // The turn is headed by the participant's name, then the answer, then a quiet copy action.
  expect(architect.querySelector('header')?.textContent).toContain('Architect');
  expect(architect.textContent).toContain('p1 says yes');
  expect(architect.querySelector('[aria-label="copyMessage"]')?.getAttribute('data-copy')).toBe(
    'p1 says yes',
  );
  const message = must(
    f.container.querySelector<HTMLElement>('[data-chat-item="round_1:message"]'),
    'the message',
  );
  expect(message.textContent).toContain('Ship it?');
  expect(message.querySelector('article')).toBeNull();
  expect(message.querySelector('[aria-label="copyMessage"]')?.getAttribute('data-copy')).toBe(
    'Ship it?',
  );
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
  // Stop, from Send's place while nothing is written: the meeting is read after it, slowly.
  await act(async () => {
    f.button('stopRound')?.click();
  });
  // A message sent meanwhile reads it again, and that answer comes first.
  await f.type('Latest question');
  await act(async () => f.button('send')?.click());
  expect(f.container.querySelector('[data-chat-item]')?.textContent).toContain('Latest question');
  await act(async () => finish(current));
  expect(f.container.querySelector('[data-chat-item]')?.textContent).toContain('Latest question');
});

it('slow polling waits for the pending response before requesting another', async () => {
  // Only the poll's clock: jsdom's animation frames run on intervals, and a faked one would not
  // come back for the tests after this.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
  expect(records()).toBeNull();
  await act(async () => f.button('viewMinutes')?.click());
  expect(records()?.hidden).toBe(false);
  expect(records()?.textContent).toContain('Meeting issue');
  // Focus moves to the records' heading, so the reader starts at the minutes.
  expect(document.activeElement?.tagName).toBe('H2');
  expect(records()?.contains(document.activeElement)).toBe(true);
});

it('an answer whose text was not kept says so instead of showing an empty card', async () => {
  const f = await mount(
    view({
      rounds: [{ ...view().rounds[0]!, answers: [{ ...answer('p1', 'answered'), text: '' }] }],
    }),
  );
  expect(f.container.querySelector('article[aria-label="Architect"]')?.textContent).toContain(
    'answerNotKept',
  );
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
  await f.chooseRecipient('Builder');
  await f.closeMenu();
  await f.openEvidence();
  await act(async () => f.button('attachEvidence')?.click());
  await f.hide();
  const other = await mount(view({ sessionId: 'another_meeting' }));
  expect(other.box.value).toBe('');
  await other.type('Another draft');
  await other.hide();
  await f.show();
  expect(f.container.querySelector('textarea')?.value).toBe('Keep this exact meeting draft.');
  expect(f.recipients()?.textContent).toBe('Builder');
  expect(f.container.querySelector('[aria-label="evidenceSelected"]')?.textContent).toContain(
    'brief.txt',
  );
  // Each part of the draft is cleared where it is: the text in the box, the recipients by
  // Auto, the evidence by its chip's ×. There is no separate Clear draft.
  expect(f.button('clearDraft')).toBeUndefined();
  await fill(must(f.container.querySelector('textarea'), 'the box'), '');
  await f.chooseRecipient('recipients.auto');
  await act(async () => f.button('removeEvidence')?.click());
  expect(f.container.querySelector('textarea')?.value).toBe('');
  expect(f.recipients()?.textContent).toBe('recipients.auto');
  expect(f.container.querySelector('[aria-label="evidenceSelected"]')).toBeNull();
  await f.hide();
  await f.show();
  expect(f.container.querySelector('textarea')?.value).toBe('');
  expect(f.recipients()?.textContent).toBe('recipients.auto');
  expect(f.container.querySelector('[aria-label="evidenceSelected"]')).toBeNull();
  // No one is a choice kept with the draft, like the names.
  await f.chooseRecipient('recipients.none');
  await f.hide();
  await f.show();
  expect(f.recipients()?.textContent).toBe('recipients.none');
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
  // The records panel is closed; the failure and its recovery are still in view.
  expect(records()).toBeNull();
  const alerts = [...f.container.querySelectorAll('[role="alert"]')];
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.closest('details')).toBeNull();
  expect(alerts[0]?.closest('[data-testid="chat-composer"]')).not.toBeNull();
  expect(f.container.textContent).not.toContain('Old failure');
  expect(f.button('retrySummary')).toBeDefined();
  await act(async () => f.button('retrySummary')?.click());
  expect(f.meetings.send.mock.calls.at(-1)?.[1]).toMatchObject({
    kind: 'message',
    mentions: ['secretary'],
  });
  // With no minutes to adopt, the next step is the composer's own request for a plan.
  expect(f.button('summarise')?.hasAttribute('disabled')).toBe(false);
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
  // The interrupt key and Alt+Enter send to the meeting too.
  await f.type('Send on Command Shift Enter');
  expect(await press({ metaKey: true, shiftKey: true })).toBe(true);
  await f.type('Send on Alt Enter');
  expect(await press({ altKey: true })).toBe(true);
  expect(f.meetings.send).toHaveBeenCalledTimes(4);
  preferences.setState({ sendKey: 'enter' });
  await f.type('Keep shift Enter as a newline');
  expect(await press({ shiftKey: true })).toBe(false);
  expect(await press({})).toBe(true);
  expect(f.meetings.send).toHaveBeenCalledTimes(5);
});

it('every send key sends to the meeting, Alt+Enter too, and an IME composition never does', async () => {
  const f = await mount(view());
  const sent = () => f.meetings.send.mock.calls.map((call) => (call[1] as { text: string }).text);
  await f.type('Enter sends');
  expect(await f.press({})).toBe(true);
  await f.type('The interrupt key sends');
  expect(await f.press({ ctrlKey: true })).toBe(true);
  await f.type('Alt Enter sends');
  expect(await f.press({ altKey: true })).toBe(true);
  expect(sent()).toEqual(['Enter sends', 'The interrupt key sends', 'Alt Enter sends']);
  for (const request of f.meetings.send.mock.calls.map((call) => call[1]))
    expect(request).toMatchObject({ kind: 'message' });
  // A composition's confirming keys, by flag or Safari's keyCode, send nothing.
  await f.type('한글');
  for (const init of [
    { isComposing: true },
    { keyCode: 229 },
    { ctrlKey: true, isComposing: true },
    { altKey: true, isComposing: true },
  ])
    await f.press(init);
  await act(async () => {
    f.box.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  });
  await f.press({});
  await act(async () => {
    f.box.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });
  expect(f.meetings.send).toHaveBeenCalledTimes(3);
  expect(f.box.value).toBe('한글');
  // One meaning, said once: the key hint names the send key alone, and there is no send menu
  // (it would never open); its place beside Send is kept, so Send sits where a conversation's does.
  const keys = [...f.container.querySelectorAll('[data-slot="composer-key"]')];
  expect(keys).toHaveLength(1);
  expect(keys[0]?.textContent).toContain('keyHint.meeting');
  expect(f.container.querySelector('[data-slot="composer-send-menu"]')).toBeNull();
  expect(f.button('sendMenu')).toBeUndefined();
  expect(f.container.querySelector('[data-slot="composer-send-menu-place"]')).not.toBeNull();
  // Send says only its name: no description repeating it.
  expect(f.button('send')?.hasAttribute('aria-description')).toBe(false);
  // A meeting has no `/` command or `@` reference menu: its box is a plain text box, and
  // `/반론` or `@name` is text the meeting reads.
  expect(f.box.getAttribute('role')).toBeNull();
  expect(f.box.hasAttribute('aria-autocomplete')).toBe(false);
});

it('the recipients badge sends to whoever the meeting picks, the chosen, or no one', async () => {
  const three = {
    ...config,
    participants: [
      ...config.participants,
      { participantId: 'p3', name: 'Critic', prompt: 'Risks.', modelProfile: 'model-a' },
    ],
  };
  const f = await mount(view({ config: three }));
  const last = () => f.meetings.send.mock.calls.at(-1)?.[1] as MeetingRoundRequest;
  const sendNow = async (text: string) => {
    await f.type(text);
    await act(async () => f.button('send')?.click());
  };
  // Auto: no recipients in the request; the meeting picks who answers.
  expect(f.recipients()?.textContent).toBe('recipients.auto');
  await sendNow('Who should answer?');
  expect(last()).not.toHaveProperty('mentions');
  expect(last()).not.toHaveProperty('recipients');
  // One participant, read on the badge by name.
  await f.chooseRecipient('Builder');
  await f.closeMenu();
  expect(f.recipients()?.textContent).toBe('Builder');
  await sendNow('Builder only');
  expect(last()).toMatchObject({ mentions: ['p2'] });
  expect(last()).not.toHaveProperty('recipients');
  // A sent message's recipients go with it: the next one is the meeting's pick again.
  expect(f.recipients()?.textContent).toBe('recipients.auto');
  // Several: the names, and the count once they no longer read at a glance.
  await f.chooseRecipient('Builder');
  await f.chooseRecipient('Architect');
  await f.closeMenu();
  expect(f.recipients()?.textContent).toBe('Builder, Architect');
  await f.chooseRecipient('Critic');
  await f.closeMenu();
  expect(f.recipients()?.textContent).toBe('recipients.count');
  await sendNow('All three of you');
  expect(last()).toMatchObject({ mentions: ['p2', 'p1', 'p3'] });
  // No one: the message is posted and nobody is asked to reply.
  await f.chooseRecipient('recipients.none');
  // Picked at once: the menu closes.
  await vi.waitFor(() => expect(document.body.querySelector('[role="menu"]')).toBeNull());
  expect(f.recipients()?.textContent).toBe('recipients.none');
  await sendNow('Just noting this');
  expect(last()).toMatchObject({ kind: 'message', text: 'Just noting this', recipients: 'none' });
  expect(last()).not.toHaveProperty('mentions');
  // Choosing someone leaves No one, and Auto clears the names.
  await f.chooseRecipient('recipients.none');
  await f.chooseRecipient('Critic');
  expect(f.recipientItem('recipients.none')?.getAttribute('aria-checked')).toBe('false');
  await f.chooseRecipient('recipients.auto');
  expect(f.recipients()?.textContent).toBe('recipients.auto');
  await sendNow('Back to auto');
  expect(last()).not.toHaveProperty('mentions');
  expect(last()).not.toHaveProperty('recipients');
});

it('restores an archived meeting from its notice or registered command without changing its draft', async () => {
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

it('widening the records hides the conversation but keeps the composer and a decision draft', async () => {
  const f = await mount(view({ minutes: [minutesWithCandidate] }));
  await f.type('A question for later');
  await act(async () => f.button('records')?.click());
  await act(async () => f.button('editCandidate')?.click());
  const goal = () => records()?.querySelector<HTMLTextAreaElement>('textarea[name="goal"]');
  const draftedGoal = must(goal(), 'the decision goal');
  await fill(draftedGoal, 'Ship after one more check');
  expect(f.button('expandRecords')?.getAttribute('aria-pressed')).toBe('false');
  await act(async () => f.button('expandRecords')?.click());
  expect(f.button('compactRecords')?.getAttribute('aria-pressed')).toBe('true');
  expect(timeline()?.hidden).toBe(true);
  expect(f.box.isConnected).toBe(true);
  expect(f.box.value).toBe('A question for later');
  expect(goal()).toBe(draftedGoal);
  expect(goal()?.value).toBe('Ship after one more check');
  await act(async () => f.button('compactRecords')?.click());
  expect(timeline()?.hidden).toBe(false);
  expect(goal()?.value).toBe('Ship after one more check');
  expect(f.box.value).toBe('A question for later');
});

it('the records panel opens and closes from the toolbar, keeping the draft, and stays open per meeting', async () => {
  const f = await mount(view({ minutes: [minutesWithCandidate] }));
  await f.type('Unsent while reading');
  await f.chooseRecipient('Builder');
  await f.closeMenu();
  const toggle = must(f.button('records'), 'the records toggle');
  expect(toggle.closest('[data-testid="chat-composer"]')).toBeNull();
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  expect(records()).toBeNull();
  await act(async () => toggle.click());
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  expect(records()?.hidden).toBe(false);
  // The panel sits beside the conversation; nothing is hidden and the composer is untouched.
  expect(records()?.contains(f.box)).toBe(false);
  expect(timeline()?.hidden).toBe(false);
  expect(f.box.isConnected).toBe(true);
  expect(f.box.value).toBe('Unsent while reading');
  expect(f.recipients()?.textContent).toBe('Builder');
  // Its open state belongs to this meeting.
  await f.hide();
  await f.show();
  expect(records()?.hidden).toBe(false);
  await f.hide();
  const other = await mount(view({ sessionId: 'another_meeting' }));
  expect(records()).toBeNull();
  await other.hide();
  await f.show();
  await act(async () => f.button('closeRecords')?.click());
  expect(records() === null || records()?.hidden).toBe(true);
  expect(f.button('records')?.getAttribute('aria-pressed')).toBe('false');
  expect(f.container.querySelector('textarea')?.value).toBe('Unsent while reading');
});

it('the records open on the minutes, without a helper sentence, and print a candidate’s goal once', async () => {
  const f = await mount(view({ minutes: [minutesWithCandidate] }));
  await act(async () => f.button('records')?.click());
  const panel = must(records(), 'the records');
  expect(panel.textContent).not.toContain('candidateHint');
  expect(panel.textContent?.split('Ship the change')).toHaveLength(2);
  // The panel title names the records; each minutes keeps its time, not a second title.
  const minutes = must(panel.querySelector('article[aria-label="minutes"]'), 'the minutes');
  expect(minutes.querySelector('h3')).toBeNull();
  expect(minutes.querySelector('time')).not.toBeNull();
  expect(panel.querySelector('[aria-label="aboutDecisions"]')).toBeNull();
});

it('closing the side records panel returns focus to the toolbar’s records toggle', async () => {
  const f = await mount(view({ minutes: [minutesWithCandidate] }));
  const toggle = must(f.button('records'), 'the records toggle');
  await act(async () => toggle.click());
  expect(records()?.hidden).toBe(false);
  for (const widen of [false, true]) {
    if (widen) {
      await act(async () => toggle.click());
      await act(async () => f.button('expandRecords')?.click());
    }
    const close = must(f.button('closeRecords'), 'the close button');
    await act(async () => {
      close.focus();
      close.click();
    });
    expect(records()?.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
  }
});

it('on a narrow screen the records open as a drawer over the conversation and return to its place', async () => {
  // A panel left open on a wide screen does not cover a phone's conversation by itself.
  localStorage.setItem('corral:meeting-records:v1:session_1', 'true');
  const f = await mount(view({ minutes: [minutesWithCandidate] }), {}, { narrow: true });
  expect(records()).toBeNull();
  const conversation = must(timeline(), 'the conversation');
  Object.defineProperty(conversation, 'scrollTop', {
    configurable: true,
    writable: true,
    value: 0,
  });
  conversation.scrollTop = 420;
  await f.type('Draft under the drawer');
  await act(async () => f.button('records')?.click());
  const drawer = document.body.querySelector('[role="dialog"]');
  expect(drawer).not.toBeNull();
  expect(drawer?.contains(records())).toBe(true);
  // Narrow screens have no side to widen into.
  expect(f.button('expandRecords')).toBeUndefined();
  expect(timeline()).toBe(conversation);
  await act(async () => f.button('closeRecords')?.click());
  await act(async () => vi.waitFor(() => expect(records()).toBeNull()));
  expect(timeline()).toBe(conversation);
  expect(timeline()?.hidden).toBe(false);
  expect(conversation.scrollTop).toBe(420);
  expect(f.box.value).toBe('Draft under the drawer');
});

const decisionGoal = () =>
  records()?.querySelector<HTMLTextAreaElement>('textarea[name="goal"]') ?? null;

it('a decision being edited in the narrow drawer survives closing and reopening it', async () => {
  const f = await mount(view({ minutes: [minutesWithCandidate] }), {}, { narrow: true });
  await act(async () => f.button('records')?.click());
  await act(async () => f.button('editCandidate')?.click());
  await fill(must(decisionGoal(), 'the decision goal'), 'Ship after the drawer closes');
  await act(async () => f.button('closeRecords')?.click());
  await act(async () => vi.waitFor(() => expect(records()).toBeNull()));
  await act(async () => f.button('records')?.click());
  expect(decisionGoal()?.value).toBe('Ship after the drawer closes');
  // Another meeting does not see it.
  await f.hide();
  const other = await mount(
    view({ sessionId: 'another_meeting', minutes: [minutesWithCandidate] }),
    {},
    { narrow: true },
  );
  await act(async () => other.button('records')?.click());
  expect(decisionGoal()).toBeNull();
});

it('a decision being edited survives the window crossing 1024px both ways', async () => {
  const f = await mount(view({ minutes: [minutesWithCandidate] }));
  await act(async () => f.button('records')?.click());
  await act(async () => f.button('editCandidate')?.click());
  await fill(must(decisionGoal(), 'the decision goal'), 'Ship on any screen');
  await f.resize({ narrow: true });
  expect(records()).toBeNull();
  await act(async () => f.button('records')?.click());
  expect(document.body.querySelector('[role="dialog"]')?.contains(records())).toBe(true);
  expect(decisionGoal()?.value).toBe('Ship on any screen');
  await fill(must(decisionGoal(), 'the decision goal'), 'Ship on any screen, checked');
  await f.resize({ narrow: false });
  await act(async () =>
    vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).toBeNull()),
  );
  expect(records()?.tagName).toBe('ASIDE');
  expect(decisionGoal()?.value).toBe('Ship on any screen, checked');
  // Cancelling is what discards it.
  await act(async () => f.button('cancel')?.click());
  expect(decisionGoal()).toBeNull();
  await f.hide();
  await f.show();
  expect(decisionGoal()).toBeNull();
});

it('clicking a participant puts an @mention at the caret without sending', async () => {
  const f = await mount(view());
  await f.type('Ask now');
  f.box.setSelectionRange(4, 4);
  const builder = participant('p2')?.querySelector('button');
  expect(builder).toBeTruthy();
  await act(async () => builder?.click());
  expect(f.box.value).toBe('Ask @Builder now');
  expect(document.activeElement).toBe(f.box);
  expect(f.box.selectionStart).toBe('Ask @Builder '.length);
  expect(f.meetings.send).not.toHaveBeenCalled();
  // A word right before the caret keeps its own space.
  f.box.setSelectionRange(f.box.value.length, f.box.value.length);
  await act(async () => participant('p1')?.querySelector('button')?.click());
  expect(f.box.value).toBe('Ask @Builder now @Architect ');
  expect(f.meetings.send).not.toHaveBeenCalled();
});

it('the participant row names everyone and says nothing of answering, waiting or failing', async () => {
  const idle = await mount(view());
  expect(participant('p2')?.textContent).not.toContain('status.failed');
  await idle.hide();
  await mount(
    view({
      rounds: [
        {
          ...firstRound(),
          active: true,
          answers: [
            answer('p1', 'running'),
            { ...answer('p2', 'running'), status: 'waiting', runId: null, usage: null },
          ],
        },
      ],
    }),
  );
  for (const id of ['p1', 'p2', 'secretary']) {
    expect(participant(id)?.textContent, id).not.toMatch(/status\./);
    expect(participant(id)?.hasAttribute('data-state'), id).toBe(false);
  }
});

it('Stop ends the answering and waiting turns through the meeting command while Send stays available', async () => {
  const f = await mount(
    view({
      rounds: [
        { ...firstRound(), active: true, answers: [answer('p1', 'running')] },
        {
          ...firstRound(),
          roundId: 'round_2',
          commandId: 'c2',
          message: 'And the rollout?',
          active: true,
          answers: [{ ...answer('p2', 'running'), status: 'waiting', runId: null, usage: null }],
        },
      ],
    }),
  );
  await f.type('One more thing');
  expect(f.button('send')?.hasAttribute('disabled')).toBe(false);
  // Something is written: Send keeps its place, and Stop is the activity bar's.
  expect(f.button('stopRound')).toBeUndefined();
  await act(async () => f.button('details')?.click());
  let finish: (value: { ok: boolean; outcome: string }) => void = () => {};
  f.meetings.stop.mockImplementationOnce(
    () =>
      new Promise<{ ok: boolean; outcome: string }>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => f.button('stop')?.click());
  // On its way: not sent again.
  expect(f.button('stop')?.hasAttribute('disabled')).toBe(true);
  await act(async () => f.button('stop')?.click());
  await act(async () => finish({ ok: true, outcome: 'updated' }));
  expect(f.meetings.stop).toHaveBeenCalledExactlyOnceWith('session_1', 'round_1');
  expect(f.meetings.send).not.toHaveBeenCalled();
  expect(f.box.value).toBe('One more thing');
});

describe('Stop that just took Send’s place', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const stopPlace = (f: { container: HTMLElement }) =>
    f.container.querySelector<HTMLButtonElement>('[data-testid="composer-stop"]');

  for (const reduced of [false, true])
    it(`is not pressed by a press meant for Send for 0.6 s${reduced ? ', reduced motion' : ''}`, async () => {
      const f = await mount(view());
      if (reduced) {
        const media = window.matchMedia;
        vi.stubGlobal('matchMedia', (query: string) =>
          query.includes('prefers-reduced-motion')
            ? { matches: true, media: query, addEventListener() {}, removeEventListener() {} }
            : media(query),
        );
      }
      // Sent: the meeting now answers, so Send's place, with nothing written, is Stop.
      f.meetings.view.mockResolvedValue(
        view({ rounds: [{ ...firstRound(), active: true, answers: [answer('p1', 'running')] }] }),
      );
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await f.type('Ship it today?');
      await act(async () => f.button('send')?.click());
      await act(async () => {});
      const place = must(stopPlace(f), 'Stop in Send’s place');
      // The second press of a double click, and presses a moment later: nothing stops.
      for (const wait of [0, 300, 150, 100]) {
        await act(async () => vi.advanceTimersByTime(wait));
        expect(stopPlace(f)?.disabled).toBe(true);
        await act(async () => stopPlace(f)?.click());
      }
      expect(f.meetings.stop).not.toHaveBeenCalled();
      // From 0.6 s on, Stop.
      await act(async () => vi.advanceTimersByTime(60));
      expect(place.isConnected && stopPlace(f)?.disabled).toBe(false);
      await act(async () => stopPlace(f)?.click());
      expect(f.meetings.stop).toHaveBeenCalledExactlyOnceWith('session_1', 'round_1');
    });

  it('while a stop is on its way, is not pressable', async () => {
    const f = await mount(
      view({ rounds: [{ ...firstRound(), active: true, answers: [answer('p1', 'running')] }] }),
    );
    let finish: (value: { ok: boolean; outcome: string }) => void = () => {};
    f.meetings.stop.mockImplementationOnce(
      () =>
        new Promise<{ ok: boolean; outcome: string }>((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => stopPlace(f)?.click());
    expect(stopPlace(f)?.disabled).toBe(true);
    await act(async () => finish({ ok: true, outcome: 'updated' }));
  });

  it('once stopped, the focus goes to the message box, from Send’s place or the bar', async () => {
    const answering = view({
      rounds: [{ ...firstRound(), active: true, answers: [answer('p1', 'running')] }],
    });
    const f = await mount(answering);
    // Pressed by keys: the browser keeps the focus on it until it leaves or is disabled.
    const place = must(stopPlace(f), 'Stop in Send’s place');
    place.focus();
    await act(async () => place.click());
    await act(async () => {});
    expect(document.activeElement).toBe(f.box);
    // The bar's Stop.
    await act(async () => f.button('details')?.click());
    const bar = must(f.button('stop'), 'the bar’s Stop');
    bar.focus();
    await act(async () => bar.click());
    await act(async () => {});
    expect(document.activeElement).toBe(f.box);
  });
});

it('renames and pins a meeting with a revision read just before the change', async () => {
  const f = await mount(view({ revision: 12 }));
  const repository = services.current.repository as any;
  // A meeting has no completion criteria: its menus offer none.
  expect(registeredCommands().some((command) => command.id === 'session:criteria')).toBe(false);
  const pin = registeredCommands().find((command) => command.id === 'session:pin');
  expect(pin?.title).toBe('pin');
  await act(async () => pin?.run());
  expect(repository.getSession).toHaveBeenCalledWith('session_1');
  expect(repository.updateSession).toHaveBeenLastCalledWith('session_1', {
    pinned: true,
    expectedRevision: 12,
  });
  const rename = registeredCommands().find((command) => command.id === 'session:rename');
  expect(rename).toBeDefined();
  await act(async () => rename?.run());
  const title = must(
    document.body.querySelector<HTMLInputElement>('input[aria-label="sessionTitle"]'),
    'the rename field',
  );
  expect(title.value).toBe('Review');
  await fill(title, 'Release review');
  await act(async () => f.button('save')?.click());
  expect(repository.updateSession).toHaveBeenLastCalledWith('session_1', {
    title: 'Release review',
    expectedRevision: 12,
  });
  // A rejected revision is reported, not retried.
  repository.updateSession.mockResolvedValueOnce({ ok: false, message: 'changed elsewhere' });
  await act(async () => pin?.run());
  expect(repository.updateSession).toHaveBeenCalledTimes(3);
  expect(f.container.textContent).toContain('changed elsewhere');
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

it('a recipients menu gives the focus back to the box, picked by pointer or closed by Escape', async () => {
  const f = await mount(view());
  const frame = () =>
    act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  // The box has the focus, and keeps it once the menu has played its exit and gone.
  const focusedBox = async (when: string) => {
    await vi.waitFor(() => expect(document.body.querySelector('[role="menu"]')).toBeNull());
    await vi.waitFor(() => expect(document.activeElement === f.box, when).toBe(true), {
      timeout: 1000,
    });
    for (let frames = 0; frames < 5; frames++) await frame();
    expect(document.activeElement === f.box, `${when}, after the menu left`).toBe(true);
  };
  for (const label of ['recipients.none', 'recipients.auto']) {
    f.recipients()?.focus();
    await f.chooseRecipient(label);
    await focusedBox(label);
  }
  f.recipients()?.focus();
  await act(async () => f.recipients()?.click());
  await vi.waitFor(() => expect(f.recipientItem('recipients.auto')).toBeDefined());
  await f.closeMenu();
  await focusedBox('Escape');
});

it('calling on a participant from the row takes a message for no one back to Auto', async () => {
  const f = await mount(view());
  await f.chooseRecipient('recipients.none');
  await f.type('A note');
  await act(async () => participant('p2')?.querySelector('button')?.click());
  expect(f.box.value).toBe('A note @Builder ');
  expect(f.recipients()?.textContent).toContain('recipients.auto');
  await act(async () => f.button('send')?.click());
  const request = f.meetings.send.mock.calls.at(-1)?.[1];
  expect(request).not.toHaveProperty('recipients');
  expect(request).toMatchObject({ text: 'A note @Builder' });
  // With names chosen, calling on someone leaves them as they are.
  await f.chooseRecipient('Architect');
  await f.closeMenu();
  await act(async () => participant('p2')?.querySelector('button')?.click());
  expect(f.recipients()?.textContent).toContain('Architect');
  expect(f.recipients()?.textContent).not.toContain('recipients.auto');
});

it('a waiting message is edited for Auto or names, never for no one', async () => {
  const f = await mount(
    view({
      rounds: [{ ...firstRound(), active: true }],
      queued: { commandId: 'queued_1', mode: 'mock', text: 'First draft', mentions: ['p1'] },
      rebuttal: null,
    }),
  );
  await act(async () => f.button('editQueuedMessage')?.click());
  const editor = must(
    f.container
      .querySelector<HTMLTextAreaElement>('textarea[aria-label="queued"]')
      ?.closest('[data-slot="textarea-control"]')?.parentElement,
    'the waiting message editor',
  );
  await act(async () => f.recipients(editor)?.click());
  await vi.waitFor(() => expect(f.recipientItem('recipients.auto')).toBeDefined());
  expect(f.recipientItem('recipients.none')).toBeUndefined();
  await f.closeMenu();
});

it('a kept draft forgets recipients the meeting no longer has', async () => {
  const kept = (text: string, meetingMentions: string[]) => ({
    text,
    meetingMentions,
    intent: null,
    target: null,
    targetLabel: null,
    references: [],
  });
  writeComposerDraft('session_1', kept('Still for Builder', ['gone', 'p2']));
  const f = await mount(view());
  expect(f.recipients()?.textContent).toContain('Builder');
  expect(f.recipients()?.textContent).not.toContain('recipients.count');
  await act(async () => f.button('send')?.click());
  expect(f.meetings.send.mock.calls.at(-1)?.[1]).toMatchObject({ mentions: ['p2'] });
  await f.hide();
  writeComposerDraft('session_2', kept('For no one left', ['gone']));
  const other = await mount(view({ sessionId: 'session_2' }));
  expect(other.box.value).toBe('For no one left');
  expect(other.recipients()?.textContent).toContain('recipients.auto');
  await act(async () => other.button('send')?.click());
  expect(other.meetings.send.mock.calls.at(-1)?.[1]).not.toHaveProperty('mentions');
});

it('the box is described by its recipients, holds 20,000 characters, and opens no list', async () => {
  const f = await mount(view());
  const described = f.box.getAttribute('aria-describedby');
  expect(described).toBeTruthy();
  expect(document.getElementById(described ?? '')).toBe(f.recipients());
  expect(f.box.maxLength).toBe(20000);
  // `/` and `@` are text here: typed in the focused box, they open no command or reference list.
  await act(async () => f.box.focus());
  for (const text of ['/', '/반론', '@', '@Bui']) {
    await f.type(text);
    expect(document.body.querySelector('[role="listbox"]')).toBeNull();
  }
});

it('Send waits for text; the recipients hold still while a send is in flight', async () => {
  const f = await mount(view());
  expect(f.button('send')?.hasAttribute('disabled')).toBe(true);
  await f.type('   ');
  expect(f.button('send')?.hasAttribute('disabled')).toBe(true);
  await f.type('Ready');
  expect(f.button('send')?.hasAttribute('disabled')).toBe(false);
  let finish!: (result: { ok: boolean; outcome: string }) => void;
  f.meetings.send.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => f.button('send')?.click());
  const held = () => {
    const badge = f.recipients();
    return Boolean(
      badge?.hasAttribute('disabled') ||
        badge?.getAttribute('aria-disabled') === 'true' ||
        badge?.hasAttribute('data-disabled'),
    );
  };
  expect(held()).toBe(true);
  await act(async () => f.recipients()?.click());
  expect(document.body.querySelector('[role="menu"]')).toBeNull();
  await act(async () => finish({ ok: true, outcome: 'started' }));
  expect(held()).toBe(false);
});

it('the recipients menu: Auto closes it, its radios say which is chosen, and unticking the last name is Auto', async () => {
  const f = await mount(view());
  await act(async () => f.recipients()?.click());
  await vi.waitFor(() => expect(f.recipientItem('recipients.auto')).toBeDefined());
  expect(f.recipientItem('recipients.auto')?.getAttribute('aria-checked')).toBe('true');
  expect(f.recipientItem('recipients.none')?.getAttribute('aria-checked')).toBe('false');
  await f.chooseRecipient('recipients.none');
  await vi.waitFor(() => expect(document.body.querySelector('[role="menu"]')).toBeNull());
  await act(async () => f.recipients()?.click());
  await vi.waitFor(() => expect(f.recipientItem('recipients.none')).toBeDefined());
  expect(f.recipientItem('recipients.none')?.getAttribute('aria-checked')).toBe('true');
  expect(f.recipientItem('recipients.auto')?.getAttribute('aria-checked')).toBe('false');
  // Auto, picked, closes the menu at once.
  await f.chooseRecipient('recipients.auto');
  await vi.waitFor(() => expect(document.body.querySelector('[role="menu"]')).toBeNull());
  expect(f.recipients()?.textContent).toContain('recipients.auto');
  // A name ticked and unticked again leaves the meeting's pick, not an empty list.
  await f.chooseRecipient('Builder');
  expect(f.recipientItem('recipients.auto')?.getAttribute('aria-checked')).toBe('false');
  await f.chooseRecipient('Builder');
  expect(f.recipientItem('recipients.auto')?.getAttribute('aria-checked')).toBe('true');
  await f.closeMenu();
  expect(f.recipients()?.textContent).toContain('recipients.auto');
  await f.type('Whoever fits');
  await act(async () => f.button('send')?.click());
  expect(f.meetings.send.mock.calls.at(-1)?.[1]).not.toHaveProperty('mentions');
});

it('a send follows the end of the conversation again, and Stop is offered only while someone answers', async () => {
  const f = await mount(view());
  const sent = () => Number(f.container.querySelector('[data-sent]')?.getAttribute('data-sent'));
  const before = sent();
  await f.type('Follow me');
  await act(async () => f.button('send')?.click());
  expect(sent()).toBe(before + 1);
  await act(async () => f.button('summarise')?.click());
  expect(sent()).toBe(before + 2);
  expect(f.button('stopRound')).toBeUndefined();
});

it('on a narrow tool line the tools keep one width whatever the meeting is doing', async () => {
  const idle = await mount(view(), {}, { compact: true });
  // Nobody answers: no Stop. The plan request is an icon with its name.
  expect(idle.button('stopRound')).toBeUndefined();
  const plan = must(idle.button('summarise'), 'the plan request');
  expect(plan.textContent?.trim()).toBe('');
  // A chosen name reads as a count there, so the badge does not grow with names.
  await idle.chooseRecipient('Builder');
  await idle.closeMenu();
  expect(idle.recipients()?.textContent).toContain('recipients.count');
  expect(idle.recipients()?.textContent).not.toContain('Builder');
  // Its name says whom, not only how many.
  expect(idle.recipients()?.getAttribute('aria-label')).toBe('recipients.labelNamed');
  expect(idle.recipients()?.closest('[data-slot="composer-target-place"]')).not.toBeNull();
  await idle.hide();
  const answering = await mount(
    view({ rounds: [{ ...firstRound(), active: true, answers: [answer('p1', 'running')] }] }),
    {},
    { compact: true },
  );
  // Stop takes Send's place, as a conversation's: nothing on the tool line changes width.
  const stop = must(answering.button('stopRound'), 'Stop');
  expect(stop.getAttribute('data-testid')).toBe('composer-stop');
  await act(async () => stop.click());
  expect(answering.meetings.stop).toHaveBeenCalledWith('session_1', 'round_1');
});

it('a recipients menu opened again before the focus comes back stays open, and the box does not take the focus', async () => {
  const f = await mount(view());
  // Closed by a pick, and opened again before the next frame.
  // Frames are held from the close until the menu is open again: the frame the close planned
  // comes after the reopening, as on a loaded machine.
  await act(async () => f.recipients()?.click());
  await vi.waitFor(() => expect(f.recipientItem('recipients.none')).toBeDefined());
  const held: FrameRequestCallback[] = [];
  const realFrame = window.requestAnimationFrame;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    held.push(callback);
    return 0;
  });
  await act(async () => f.recipientItem('recipients.none')?.click());
  expect(f.recipients()?.textContent).toContain('recipients.none');
  await act(async () => f.recipients()?.click());
  await vi.waitFor(() => expect(f.recipients()?.getAttribute('aria-expanded')).toBe('true'));
  vi.stubGlobal('requestAnimationFrame', realFrame);
  expect(held.length).toBeGreaterThan(0);
  // The box never takes the focus from the open menu, not even for a moment.
  let taken = false;
  f.box.addEventListener('focus', () => {
    taken = true;
  });
  await act(async () => {
    for (const callback of held.splice(0)) callback(performance.now());
  });
  for (let frames = 0; frames < 5; frames++)
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
  expect(f.recipients()?.getAttribute('aria-expanded')).toBe('true');
  expect(taken).toBe(false);
  expect(document.activeElement).not.toBe(f.box);
  await f.closeMenu();
});

it('an earlier version’s waiting message stands in the conversation’s queue line, sent now only when idle', async () => {
  const waiting = {
    commandId: 'queued_1',
    mode: 'mock' as const,
    text: 'Left over',
    mentions: ['p2'],
  };
  const idle = await mount(view({ queued: waiting, rebuttal: null }));
  const card = must(idle.button('editQueuedMessage')?.closest('section'), 'the queue line');
  expect(card.getAttribute('aria-label')).toBe('queueHeading');
  expect(card.textContent).toContain('Left over');
  // Whom it is for, on its card; and no line of explanation under it.
  expect(card.textContent).toContain('to');
  expect(idle.container.textContent).not.toContain('queuedHint');
  expect(idle.container.textContent).not.toContain('queuedIdle');
  await act(async () => idle.button('sendQueued')?.click());
  expect(idle.meetings.sendQueued).toHaveBeenCalledWith('session_1');
});
