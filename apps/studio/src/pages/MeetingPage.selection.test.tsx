// @vitest-environment jsdom
import type { MeetingSelection, MeetingView } from '@corral/contracts';
import type { WorkSession } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };

// What a person's message says about who receives it, and the card a held mention chain waits
// on (workbench.md, the meeting's timeline and composer; features/local-intelligence.md, the
// selection record and the chain). In the words the person reads.

const services = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../services.tsx', () => ({ useServices: () => services.current }));
vi.mock('../workbench/useModels.ts', () => ({ useModelProfiles: () => null }));
vi.mock('../workbench/useCorralChat.ts', () => ({
  useCorralRun: () => ({ state: { projection: null, streams: {} } }),
}));
vi.mock('../workbench/MeetingEvidence.tsx', () => ({ MeetingEvidencePicker: () => null }));
vi.mock('../workbench/ChatView.tsx', () => ({
  ChatDensityMenu: () => null,
  ChatView: ({ items, composer, header, children, tray }: any) => (
    <div data-chat-view>
      {header}
      <section data-testid="chat-timeline">
        {children}
        {items.map((item: any) => (
          <div key={item.id} data-chat-item={item.id}>
            {item.content}
          </div>
        ))}
        {tray}
      </section>
      <div data-testid="chat-composer">{composer}</div>
    </div>
  ),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: any) => <a href="#run">{children}</a>,
  useRouter: () => ({ invalidate: async () => {} }),
}));
vi.mock('@corral/react', () => ({
  SafeMarkdown: ({ text }: any) => <p>{text}</p>,
  FailureNotice: ({ message }: any) => <p>{message}</p>,
  CopyTextButton: () => <button type="button" aria-label="copy" />,
}));

const { MeetingPage } = await import('./MeetingPage.tsx');
const { TopbarSlotContext } = await import('../workbench/TopbarSlot.tsx');
const { writeComposerDraft } = await import('../workbench/sessionDraft.ts');
const m = messages.Meetings;

const config = {
  version: 1 as const,
  participants: [
    { participantId: 'p1', name: 'Architect', prompt: 'Structure.', modelProfile: 'model-a' },
    { participantId: 'p2', name: 'Builder', prompt: 'Delivery.', modelProfile: 'model-b' },
    { participantId: 'p3', name: 'Critic', prompt: 'Risks.', modelProfile: 'model-a' },
  ],
  secretary: { modelProfile: 'model-a' },
};
type Round = MeetingView['rounds'][number];
const answered = (participantId: string, text = `${participantId} says yes`) => ({
  participantId,
  runId: `run_${participantId}`,
  status: 'answered' as const,
  text,
  detail: null,
  usage: { modelCalls: 1, outputTokens: 12, unknown: false },
});
const running = (participantId: string) => ({
  ...answered(participantId),
  status: 'running' as const,
  text: null,
});
function round(id: string, change: Partial<Round> = {}): Round {
  return {
    roundId: id,
    commandId: `c_${id}`,
    kind: 'all',
    message: `Message ${id}`,
    basedOnRoundId: null,
    rebuttalNo: null,
    participantIds: ['p2'],
    createdAt: 'x',
    stoppedAt: null,
    active: false,
    answers: [answered('p2')],
    ...change,
  } as Round;
}
function view(rounds: Round[], change: Partial<MeetingView> = {}): MeetingView {
  return {
    sessionId: 'session_1',
    revision: 2,
    config,
    rounds,
    queued: null,
    rebuttal: null,
    ...change,
  };
}
const select = (selection: MeetingSelection) => ({ selection });

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function mount(first: MeetingView, { compact = false } = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: compact && query === '(max-width: 639px)',
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
  const animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  });
  cleanups.push(async () => {
    if (animations) Object.defineProperty(Element.prototype, 'getAnimations', animations);
    else Reflect.deleteProperty(Element.prototype, 'getAnimations');
  });
  let current = first;
  const meetings = {
    view: vi.fn(async () => current),
    send: vi.fn(async () => ({ ok: true, outcome: 'started' })),
    stop: vi.fn(async () => ({ ok: true, outcome: 'updated' })),
    continueChain: vi.fn(
      async (_sessionId: string, _request: { commandId: string }): Promise<any> => ({
        ok: true,
        outcome: 'started',
        roundId: 'round_next',
      }),
    ),
    sendQueued: vi.fn(),
    dropQueued: vi.fn(),
    editQueued: vi.fn(),
  };
  services.current = {
    meetings,
    mode: 'browser',
    live: false,
    repository: {
      getSession: vi.fn(async () => ({ revision: 2 })),
      updateSession: vi.fn(async () => ({ ok: true })),
    },
  };
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
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <TopbarSlotContext.Provider value={{ actions: toolbar, views: null, crumbs: null }}>
          <MeetingPage
            session={{ sessionId: 'session_1', title: 'Review', revision: 3 } as WorkSession}
          />
        </TopbarSlotContext.Provider>
      </IntlProvider>,
    ),
  );
  const meta = (roundId: string) =>
    container.querySelector<HTMLElement>(
      `[data-chat-item="${roundId}:message"] [data-chat-part="meta"]`,
    );
  const card = () => container.querySelector<HTMLElement>('[data-meeting-hold]');
  const continueButton = () =>
    [...(card()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent?.trim() === m.hold.continue,
    );
  return {
    container,
    meetings,
    meta,
    card,
    continueButton,
    box: () => container.querySelector('textarea'),
    /** The view the next refresh reads. */
    next: (view: MeetingView) => {
      current = view;
    },
    /** The poll reads this view next (it polls while an answer is running). */
    refresh: async (view: MeetingView) => {
      current = view;
      const calls = meetings.view.mock.calls.length;
      await vi.waitFor(() => expect(meetings.view.mock.calls.length).toBeGreaterThan(calls), {
        timeout: 3000,
      });
      await act(async () => {
        await meetings.view.mock.results.at(-1)?.value;
      });
    },
  };
}
const popover = () => document.body.querySelector<HTMLElement>('[data-meeting-selection]');
const ranking = () =>
  [...(popover()?.querySelectorAll('li') ?? [])].map((item) => item.textContent?.trim());

describe('the message’s meta line says who receives it, once', () => {
  it('chosen or @mentioned: the receivers by name', async () => {
    const f = await mount(
      view([
        round('r1', {
          kind: 'mention',
          participantIds: ['p2', 'p1'],
          answers: [answered('p2'), answered('p1')],
          ...select({ strategy: 'explicit', reason: 'composer_recipients' }),
        }),
        round('r2', {
          kind: 'mention',
          participantIds: ['p3'],
          answers: [answered('p3')],
          ...select({ strategy: 'mention', reason: 'mention' }),
        }),
      ]),
    );
    expect(f.meta('r1')?.textContent).toContain(m.to.replace('{names}', 'Builder, Architect'));
    expect(f.meta('r1')?.querySelector('[aria-haspopup]')).toBeNull();
    expect(f.meta('r2')?.textContent).toContain(m.to.replace('{names}', 'Critic'));
    // The line over the bubble is gone: the meta line says it.
    expect(f.container.querySelector('[data-chat-item="r1:message"]')?.textContent).not.toMatch(
      /To: .*To: /,
    );
  });

  it('picked by the selector: Auto, and its method, reason and scores, the pick first', async () => {
    const f = await mount(
      view([
        round('r1', {
          participantIds: ['p2'],
          answers: [answered('p2')],
          ...select({
            strategy: 'selector',
            reason: 'top_score',
            scores: [
              { participantId: 'p1', score: 0.42 },
              { participantId: 'p2', score: 0.81 },
              { participantId: 'gone', score: 0.9 },
              { participantId: 'p3', score: 0.1 },
            ],
          }),
        }),
      ]),
    );
    const line = f.meta('r1');
    // The pick is the answer's to name, not the line's.
    expect(line?.textContent).not.toContain('Builder');
    const auto = [...(line?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent?.trim() === m.meta.auto,
    );
    expect(auto?.getAttribute('aria-label')).toBe(m.selection.open.replace('{label}', m.meta.auto));
    expect(popover()).toBeNull();
    await act(async () => auto?.click());
    await vi.waitFor(() => expect(popover()).not.toBeNull());
    expect(popover()?.textContent).toContain(m.selection.reason.top_score);
    expect(ranking()).toEqual([
      expect.stringMatching(/^Builder.*0\.81$/),
      expect.stringMatching(/^Architect.*0\.42$/),
      expect.stringMatching(/^Critic.*0\.1$/),
    ]);
    // The picked participant stands out from the rest.
    const items = [...(popover()?.querySelectorAll('li') ?? [])];
    expect(items[0]?.hasAttribute('data-picked')).toBe(true);
    expect(items[1]?.hasAttribute('data-picked')).toBe(false);
    expect(items[0]?.textContent).toContain(m.selection.picked);
    await act(async () =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    await vi.waitFor(() => expect(popover()).toBeNull());
  });

  it('a fallback pick: Auto opens its reason, with no ranking when nothing was scored', async () => {
    const f = await mount(
      view([
        round('r1', {
          participantIds: ['p3'],
          answers: [answered('p3')],
          ...select({ strategy: 'fallback', reason: 'rotation' }),
        }),
      ]),
    );
    await act(async () =>
      f
        .meta('r1')
        ?.querySelector('button[aria-haspopup]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    await vi.waitFor(() => expect(popover()).not.toBeNull());
    expect(popover()?.textContent).toContain(m.selection.reason.rotation);
    expect(popover()?.querySelector('ol')).toBeNull();
  });

  it('nobody answers: No reply, which explains itself only when the meeting picked nobody', async () => {
    const f = await mount(
      view([
        round('mine', {
          participantIds: [],
          answers: [],
          ...select({ strategy: 'none', reason: 'no_recipients' }),
        }),
        round('picked', {
          participantIds: [],
          answers: [],
          ...select({ strategy: 'selector', reason: 'no_reply_needed' }),
        }),
      ]),
    );
    // The person chose no one: words only.
    expect(f.meta('mine')?.textContent).toContain(m.meta.noReply);
    expect(f.meta('mine')?.querySelector('[aria-haspopup]')).toBeNull();
    // The meeting chose no one: the words open why.
    const why = f.meta('picked')?.querySelector<HTMLButtonElement>('button[aria-haspopup]');
    expect(why?.textContent?.trim()).toBe(m.meta.noReply);
    await act(async () => why?.click());
    await vi.waitFor(() => expect(popover()).not.toBeNull());
    expect(popover()?.textContent).toContain(m.selection.reason.no_reply_needed);
  });

  it('a round kept without its selection says only whom a mention was for', async () => {
    const f = await mount(
      view([
        round('general', { participantIds: ['p1', 'p2'], answers: [answered('p1')] }),
        round('called', { kind: 'mention', participantIds: ['p3'], answers: [answered('p3')] }),
      ]),
    );
    const general = f.meta('general')?.textContent ?? '';
    expect(general).not.toContain(m.meta.auto);
    expect(general).not.toContain(m.meta.noReply);
    expect(general).not.toContain('To:');
    expect(f.meta('called')?.textContent).toContain(m.to.replace('{names}', 'Critic'));
  });
});

describe('a held mention chain waits on the continue card', () => {
  const hold = { kind: 'chain' as const, after: 'r2' };
  const heldView = (after = 'r2') =>
    view(
      [
        round('r1'),
        round('r2', {
          kind: 'mention',
          message: null,
          participantIds: ['p1', 'p3'],
          // The second answer started after the first set the hold.
          answers: [answered('p1', '@Builder over to you'), running('p3')],
          active: true,
        }),
      ],
      { hold: { ...hold, after } },
    );

  it('stands at the end of the timeline and can be pressed while an answer is still coming', async () => {
    const f = await mount(heldView());
    const timeline = f.container.querySelector('[data-testid="chat-timeline"]');
    // In the needed-now place, after every item.
    const tray = f.card()?.closest('[data-pending-tray]');
    expect(tray).not.toBeNull();
    expect(timeline?.lastElementChild).toBe(tray);
    expect(f.card()?.textContent).toContain(m.hold.title);
    expect(f.continueButton()?.disabled).toBe(false);
    // Stopping the answer still running is the composer's, beside it.
    expect(
      [...f.container.querySelectorAll('button')].some(
        (button) => button.textContent?.trim() === m.stopRound,
      ),
    ).toBe(true);
  });

  it('sends one command; a second press while it is on its way sends nothing', async () => {
    const f = await mount(heldView());
    let finish!: (value: unknown) => void;
    f.meetings.continueChain.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => f.continueButton()?.click());
    expect(f.meetings.continueChain).toHaveBeenCalledTimes(1);
    expect(f.meetings.continueChain.mock.calls[0]?.[0]).toBe('session_1');
    expect(f.meetings.continueChain.mock.calls[0]?.[1]).toEqual({
      commandId: expect.any(String),
    });
    // Waiting for its receipt: unpressable.
    expect(f.continueButton()?.disabled).toBe(true);
    await act(async () => f.continueButton()?.click());
    expect(f.meetings.continueChain).toHaveBeenCalledTimes(1);
    // Confirmed: the card folds to its result, and goes once the meeting no longer waits.
    f.next(view([round('r1'), round('r2', { kind: 'mention', message: null })]));
    await act(async () => finish({ ok: true, outcome: 'started', roundId: 'r3' }));
    await vi.waitFor(() => expect(f.card()).toBeNull());
  });

  it('refused: free to press again, the reason in its place, and the same command again', async () => {
    const f = await mount(heldView());
    f.meetings.continueChain.mockResolvedValueOnce({
      ok: false,
      error: 'busy',
      message: 'A reply is starting.',
    });
    await act(async () => f.continueButton()?.click());
    const said = m.hold.refused.replace('{message}', 'A reply is starting.');
    // Shown in the card, under what it asks, and announced.
    const shown = [...(f.card()?.querySelectorAll('p') ?? [])].filter(
      (node) => node.textContent === said && !node.classList.contains('sr-only'),
    );
    expect(shown).toHaveLength(1);
    expect(f.card()?.querySelector('[role="alert"]')?.textContent).toBe(said);
    expect(f.continueButton()?.disabled).toBe(false);
    // The page's own error line does not say it a second time.
    expect(
      [...f.container.querySelectorAll('[role="alert"]')].filter((node) =>
        node.textContent?.includes('A reply is starting.'),
      ),
    ).toHaveLength(1);
    await act(async () => f.continueButton()?.click());
    const [first, second] = f.meetings.continueChain.mock.calls.map((call) => call[1].commandId);
    expect(second).toBe(first);
  });

  it('a lost receipt is sent again only with the same command; a new hold has its own', async () => {
    const f = await mount(heldView());
    f.meetings.continueChain.mockRejectedValueOnce(new Error('connection lost'));
    await act(async () => f.continueButton()?.click());
    expect(f.continueButton()?.disabled).toBe(false);
    f.meetings.continueChain.mockRejectedValueOnce(new Error('connection lost'));
    await act(async () => f.continueButton()?.click());
    const ids = () => f.meetings.continueChain.mock.calls.map((call) => call[1].commandId);
    expect(new Set(ids()).size).toBe(1);
    // The chain went on and stopped again, later: another hold, another command.
    await f.refresh(heldView('r9'));
    await act(async () => f.continueButton()?.click());
    expect(ids()).toHaveLength(3);
    expect(ids()[2]).not.toBe(ids()[0]);
  });

  it('a receipt that comes after the hold was released changes nothing', async () => {
    const f = await mount(heldView());
    let finish!: (value: unknown) => void;
    f.meetings.continueChain.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => f.continueButton()?.click());
    // The poll reads the meeting going on before the receipt arrives.
    await f.refresh(view([round('r1'), round('r3', { continued: true, message: null })]));
    await vi.waitFor(() => expect(f.card()).toBeNull(), { timeout: 3000 });
    await act(async () => finish({ ok: false, error: 'conflict', message: 'Late refusal.' }));
    expect(f.card()).toBeNull();
    expect(f.container.textContent).not.toContain('Late refusal.');
  });

  it('answered from the card, the focus goes to the message box', async () => {
    const f = await mount(heldView());
    f.continueButton()?.focus();
    f.next(view([round('r1'), round('r3', { continued: true, message: null })]));
    await act(async () => f.continueButton()?.click());
    await vi.waitFor(() => expect(document.activeElement).toBe(f.box()));
  });

  it('the round it continued says so where it stands', async () => {
    const f = await mount(
      view([
        round('r1'),
        round('r3', {
          kind: 'mention',
          message: null,
          continued: true,
          participantIds: ['p2'],
          answers: [answered('p2')],
        }),
      ]),
    );
    const line = f.container.querySelector('[data-chat-item="r3:continued"]');
    expect(line?.textContent).toBe(m.continued);
    // Before the answers it led to.
    const order = [...f.container.querySelectorAll('[data-chat-item]')].map((node) =>
      node.getAttribute('data-chat-item'),
    );
    expect(order.indexOf('r3:continued')).toBeLessThan(order.indexOf('r3:p2'));
    expect(f.card()).toBeNull();
  });

  it('a continued round still waiting comes after the answers that were already waiting', async () => {
    const waiting = (participantId: string) => ({
      ...answered(participantId),
      runId: null,
      status: 'waiting' as const,
      text: null,
    });
    const order = (f: { container: HTMLElement }) =>
      [...f.container.querySelectorAll('[data-chat-item]')].map((node) =>
        node.getAttribute('data-chat-item'),
      );
    const held = [
      round('r1', { order: 0, answers: [{ ...answered('p2'), order: 1 }] }),
      round('r2', {
        kind: 'mention',
        message: null,
        order: 2,
        active: true,
        participantIds: ['p1', 'p3'],
        answers: [{ ...answered('p1'), order: 3 }, waiting('p3')],
      }),
    ];
    const f = await mount(view(held));
    const before = order(f);
    expect(before.at(-1)).toBe('r2:p3');
    // Continued: the new round's line and answer go after the waiting answer, which stays.
    await f.refresh(
      view([
        ...held,
        round('r3', {
          kind: 'mention',
          message: null,
          order: 4,
          active: true,
          continued: true,
          participantIds: ['p2'],
          answers: [waiting('p2')],
        }),
      ]),
    );
    expect(order(f)).toEqual([...before, 'r3:continued', 'r3:p2']);
    // Its answer starts: the line stays just before it.
    await f.refresh(
      view([
        ...held.slice(0, 1),
        round('r2', {
          kind: 'mention',
          message: null,
          order: 2,
          active: true,
          participantIds: ['p1', 'p3'],
          answers: [
            { ...answered('p1'), order: 3 },
            { ...answered('p3'), order: 5 },
          ],
        }),
        round('r3', {
          kind: 'mention',
          message: null,
          order: 4,
          active: true,
          continued: true,
          participantIds: ['p2'],
          answers: [{ ...running('p2'), order: 6 }],
        }),
      ]),
    );
    expect(order(f)).toEqual([...before, 'r3:continued', 'r3:p2']);
  });
});

it('on a narrow tool line the recipients read as a count, and are named for assistive tech', async () => {
  writeComposerDraft('session_1', {
    text: 'For the two of you',
    meetingMentions: ['p2', 'p1'],
    intent: null,
    target: null,
    targetLabel: null,
    references: [],
  });
  const f = await mount(view([round('r1')]), { compact: true });
  const badge = f.container.querySelector('[data-slot="composer-target"]');
  expect(badge?.textContent).toContain('2 people');
  expect(badge?.getAttribute('aria-label')).toBe('Recipients (2 people): Builder, Architect');
});
