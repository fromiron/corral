// @vitest-environment jsdom
import { type MeetingSelection, type MeetingView, SECRETARY_ID } from '@corral/contracts';
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
vi.mock('@corral/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@corral/react')>()),
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

  it('receivers, but every answer skipped for a later message: Skipped, words only, however chosen', async () => {
    const f = await mount(
      view([
        round('picked', {
          participantIds: ['p2'],
          answers: [],
          ...select({
            strategy: 'selector',
            reason: 'top_score',
            scores: [{ participantId: 'p2', score: 0.8 }],
          }),
        }),
        round('chosen', {
          participantIds: ['p1', 'p3'],
          answers: [],
          ...select({ strategy: 'explicit', reason: 'composer_recipients' }),
        }),
      ]),
    );
    for (const id of ['picked', 'chosen']) {
      const line = f.meta(id)?.textContent ?? '';
      expect(line, id).toContain(m.meta.skipped);
      // Not "No reply", and nothing that opens a pick no one answered.
      expect(line, id).not.toContain(m.meta.noReply);
      expect(f.meta(id)?.querySelector('[aria-haspopup]'), id).toBeNull();
    }
  });

  it('a reason this screen does not know is said by its method alone', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await mount(
      view([
        round('r1', {
          participantIds: ['p2'],
          answers: [answered('p2')],
          selection: { strategy: 'selector', reason: 'a_future_reason' } as never,
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
    expect(popover()?.textContent).toContain(m.selection.method.selector);
    expect(popover()?.textContent).not.toContain('a_future_reason');
    expect(popover()?.textContent).not.toContain('selection.reason');
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('a message for the secretary names the secretary', async () => {
    const f = await mount(
      view([
        round('r1', {
          kind: 'secretary',
          participantIds: [SECRETARY_ID],
          answers: [answered(SECRETARY_ID)],
          ...select({ strategy: 'explicit', reason: 'composer_recipients' }),
        }),
      ]),
    );
    expect(f.meta('r1')?.textContent).toContain(m.to.replace('{names}', m.secretary));
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
    // Stopping the answer still running is the composer's: Send's place, while nothing is written.
    expect(
      f.container.querySelector('[data-testid="composer-stop"]')?.getAttribute('aria-label'),
    ).toBe(m.stopRound);
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
    // Pressable again once the meeting read again is on screen.
    await vi.waitFor(() => expect(f.continueButton()?.disabled).toBe(false));
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

  it.each([
    ['a refusal', { ok: false, error: 'conflict', message: 'Late refusal.' }],
    ['a confirmation', { ok: true, outcome: 'started', roundId: 'r3' }],
  ])('%s that comes after the hold was released changes nothing', async (_name, receipt) => {
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
    const reads = f.meetings.view.mock.calls.length;
    await act(async () => finish(receipt));
    expect(f.card()).toBeNull();
    expect(f.container.textContent).not.toContain('Late refusal.');
    // Nothing is read again for a card that is gone.
    expect(f.meetings.view.mock.calls.length).toBe(reads);
  });

  it('one name while it asks; confirmed, a single line that says Continued, with no card around it', async () => {
    const f = await mount(heldView());
    // The card names itself; the place it stands in adds no second name.
    expect(
      [...f.container.querySelectorAll('[aria-label]')].filter(
        (node) => node.getAttribute('aria-label') === m.hold.region,
      ),
    ).toHaveLength(1);
    expect(f.card()?.querySelector('header')?.textContent).toBe(m.hold.heading);
    // The meeting is read again and still holds at the same place (not yet gone on).
    await act(async () => f.continueButton()?.click());
    await vi.waitFor(() => expect(f.continueButton()).toBeUndefined());
    expect(f.card()?.querySelector('[role="status"]')?.textContent).toBe(m.hold.continued);
    expect(f.card()?.textContent).toBe(m.hold.continued);
    expect(f.card()?.querySelector('header')).toBeNull();
  });

  it('held again at the same place after a continue: a new card with a new command', async () => {
    const f = await mount(heldView());
    // The chain goes on and stops again after the same round, in the same call.
    const heldAgain = (commandId: string) =>
      view(
        [
          round('r1'),
          round('r2', {
            kind: 'mention',
            message: null,
            participantIds: ['p1', 'p3'],
            answers: [answered('p1', '@Builder over to you'), answered('p3')],
          }),
          round('r3', {
            kind: 'mention',
            message: null,
            continued: true,
            commandId,
            participantIds: ['p2'],
            answers: [answered('p2', '@Architect your turn')],
          }),
        ],
        { hold: { kind: 'chain', after: 'r2' } },
      );
    f.meetings.continueChain.mockImplementationOnce(async (_id, { commandId }) => {
      f.next(heldAgain(commandId));
      return { ok: true, outcome: 'started', roundId: 'r3' };
    });
    await act(async () => f.continueButton()?.click());
    // Not left as Continued: a card to press again.
    await vi.waitFor(() => expect(f.continueButton()?.disabled).toBe(false));
    expect(f.card()?.querySelector('[role="status"]')).toBeNull();
    expect(f.card()?.querySelector('header')?.textContent).toBe(m.hold.heading);
    // Held a third time at the same place: again a new card, read from the last continue.
    f.meetings.continueChain.mockImplementationOnce(async (_id, { commandId }) => {
      const again = heldAgain(f.meetings.continueChain.mock.calls[0]?.[1].commandId ?? '');
      f.next({
        ...again,
        rounds: [
          ...again.rounds,
          round('r4', {
            kind: 'mention',
            message: null,
            continued: true,
            commandId,
            participantIds: ['p2'],
            answers: [answered('p2', '@Architect once more')],
          }),
        ],
      });
      return { ok: true, outcome: 'started', roundId: 'r4' };
    });
    await act(async () => f.continueButton()?.click());
    await vi.waitFor(() => expect(f.continueButton()?.disabled).toBe(false));
    expect(f.card()?.querySelector('[role="status"]')).toBeNull();
    await act(async () => f.continueButton()?.click());
    const ids = f.meetings.continueChain.mock.calls.map((call) => call[1].commandId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it('not confirmed, but the meeting went on: read once, and the hold that came again is new', async () => {
    const f = await mount(heldView());
    f.meetings.continueChain.mockImplementationOnce(async (_id, { commandId }) => {
      f.next(
        view(
          [
            round('r1'),
            round('r3', { kind: 'mention', message: null, continued: true, commandId }),
          ],
          { hold: { kind: 'chain', after: 'r2' } },
        ),
      );
      throw new Error('connection lost');
    });
    const reads = f.meetings.view.mock.calls.length;
    f.continueButton()?.focus();
    await act(async () => f.continueButton()?.click());
    await vi.waitFor(() => expect(f.meetings.view.mock.calls.length).toBe(reads + 1));
    await vi.waitFor(() => expect(f.continueButton()?.disabled).toBe(false));
    // Answered from the card by keys: the focus is on the new card's Continue.
    await vi.waitFor(() => expect(document.activeElement).toBe(f.continueButton()));
    await act(async () => f.continueButton()?.click());
    const ids = f.meetings.continueChain.mock.calls.map((call) => call[1].commandId);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it('not confirmed, and the meeting went on with no hold: the focus goes to the message box', async () => {
    const f = await mount(heldView());
    f.meetings.continueChain.mockImplementationOnce(async (_id, { commandId }) => {
      f.next(
        view([
          round('r1'),
          round('r3', { kind: 'mention', message: null, continued: true, commandId }),
        ]),
      );
      throw new Error('connection lost');
    });
    f.continueButton()?.focus();
    await act(async () => f.continueButton()?.click());
    await vi.waitFor(() => expect(f.card()).toBeNull());
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(f.container.querySelector('textarea')),
    );
  });

  it('refused or not confirmed: the focus is back on Continue, unless the person moved it', async () => {
    const f = await mount(heldView());
    const deferred = () => {
      let settle!: { resolve(value: unknown): void; reject(error: Error): void };
      f.meetings.continueChain.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            settle = { resolve, reject };
          }),
      );
      return () => settle;
    };
    // While it is on its way the button is disabled, and the browser drops its focus (jsdom
    // keeps it on a disabled button, so the focus goes through an element that then leaves).
    const press = async () => {
      f.continueButton()?.focus();
      await act(async () => f.continueButton()?.click());
      const passing = document.body.appendChild(document.createElement('button'));
      passing.focus();
      passing.remove();
      expect(document.activeElement).toBe(document.body);
    };
    let settle = deferred();
    await press();
    await act(async () => settle().resolve({ ok: false, error: 'busy', message: 'Busy.' }));
    expect(document.activeElement).toBe(f.continueButton());
    settle = deferred();
    await press();
    await act(async () => settle().reject(new Error('connection lost')));
    await vi.waitFor(() => expect(document.activeElement).toBe(f.continueButton()));
    // Moved elsewhere while it was on its way: left there.
    settle = deferred();
    await press();
    f.box()?.focus();
    await act(async () => settle().resolve({ ok: false, error: 'busy', message: 'Busy.' }));
    expect(document.activeElement).toBe(f.box());
  });

  it('answered from the card with the focus moved away meanwhile: the focus stays', async () => {
    const f = await mount(heldView());
    let finish!: (value: unknown) => void;
    f.meetings.continueChain.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    f.continueButton()?.focus();
    await act(async () => f.continueButton()?.click());
    const elsewhere = f.container.querySelector<HTMLButtonElement>('button[aria-label="copy"]');
    elsewhere?.focus();
    f.next(view([round('r1'), round('r3', { continued: true, message: null })]));
    await act(async () => finish({ ok: true, outcome: 'started', roundId: 'r3' }));
    await vi.waitFor(() => expect(f.card()).toBeNull());
    await act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
    expect(document.activeElement).toBe(elsewhere);
  });

  it('a continued round with no answer yet: its line comes after what was said', async () => {
    const f = await mount(
      view([
        round('r1', { order: 0, answers: [{ ...answered('p2'), order: 1 }] }),
        round('r2', {
          kind: 'mention',
          message: null,
          order: 2,
          continued: true,
          participantIds: [],
          answers: [],
        }),
      ]),
    );
    expect(
      [...f.container.querySelectorAll('[data-chat-item]')].map((node) =>
        node.getAttribute('data-chat-item'),
      ),
    ).toEqual(['r1:message', 'r1:p2', 'r2:continued']);
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

  it('an answer not started has no row; once started, its row comes at the end and nothing moves', async () => {
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
    const r1 = round('r1', { order: 0, answers: [{ ...answered('p2'), order: 1 }] });
    const r2 = (answers: Round['answers']) =>
      round('r2', {
        kind: 'mention',
        message: null,
        order: 2,
        active: true,
        participantIds: ['p1', 'p3'],
        answers,
      });
    const f = await mount(view([r1, r2([{ ...answered('p1'), order: 3 }, waiting('p3')])]));
    const before = order(f);
    // The waiting answer is not in the timeline.
    expect(before).toEqual(['r1:message', 'r1:p2', 'r2:p1']);
    // Continued: the line stands where the person continued, after what was said by then.
    const r3 = (answers: Round['answers']) =>
      round('r3', {
        kind: 'mention',
        message: null,
        order: 4,
        active: true,
        continued: true,
        participantIds: ['p2'],
        answers,
      });
    await f.refresh(
      view([r1, r2([{ ...answered('p1'), order: 3 }, waiting('p3')]), r3([waiting('p2')])]),
    );
    expect(order(f)).toEqual([...before, 'r3:continued']);
    // The answer that was waiting starts: its row comes at the end, the rest stay as they were.
    await f.refresh(
      view([
        r1,
        r2([
          { ...answered('p1'), order: 3 },
          { ...running('p3'), order: 5 },
        ]),
        r3([waiting('p2')]),
      ]),
    );
    expect(order(f)).toEqual([...before, 'r3:continued', 'r2:p3']);
    // Then the continued round's own answer, after it.
    await f.refresh(
      view([
        r1,
        r2([
          { ...answered('p1'), order: 3 },
          { ...answered('p3'), order: 5 },
        ]),
        r3([{ ...running('p2'), order: 6 }]),
      ]),
    );
    expect(order(f)).toEqual([...before, 'r3:continued', 'r2:p3', 'r3:p2']);
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

describe('the meeting’s activity bar', () => {
  const ma = m.activity;
  const activity = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-testid="activity-bar"]');
  const line = (container: HTMLElement) =>
    activity(container)?.querySelector<HTMLElement>('[data-activity-bar] > div') ?? null;
  // The line's words as they are now: words leaving after a change carry no mark.
  const said = (container: HTMLElement) =>
    [...(line(container)?.querySelectorAll('[data-activity-text], [data-presence-label]') ?? [])]
      .map((node) => node.textContent)
      .join(' ');
  const waiting = (participantId: string) => ({
    ...answered(participantId),
    runId: null,
    status: 'waiting' as const,
    text: null,
  });
  // Everything in the timeline on screen, as an observer reports it.
  const allInView = () =>
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private readonly report: IntersectionObserverCallback;
        constructor(report: IntersectionObserverCallback) {
          this.report = report;
        }
        observe(target: Element) {
          queueMicrotask(() =>
            this.report(
              [{ target, isIntersecting: true, intersectionRect: { height: 10 } } as never],
              this as never,
            ),
          );
        }
        unobserve() {}
        disconnect() {}
      },
    );
  const open = async (f: { container: HTMLElement }) => {
    const toggle = activity(f.container)?.querySelector<HTMLButtonElement>(
      '[data-activity-toggle]',
    );
    await act(async () => toggle?.click());
  };
  const going = () =>
    view([
      round('r1', {
        participantIds: ['p2', 'p1', 'p3'],
        active: true,
        answers: [running('p2'), waiting('p1'), waiting('p3')],
      }),
      round('r2', {
        kind: 'mention',
        message: null,
        participantIds: ['p3'],
        active: true,
        answers: [waiting('p3')],
      }),
    ]);
  const viewButton = (container: HTMLElement) =>
    [...(line(container)?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === messages.Activity.view,
    );

  it('an answer out of view: who answers, with View, and how many wait', async () => {
    const f = await mount(going());
    const words = line(f.container)?.textContent ?? '';
    expect(words).toContain(m.status.running);
    expect(words).toContain('Builder');
    expect(words).toContain(ma.waiting.replace('{count}', '2'));
    expect(viewButton(f.container)).toBeDefined();
  });

  it('an answer whose row is on screen is not named again', async () => {
    allInView();
    const f = await mount(going());
    await vi.waitFor(() => expect(activity(f.container)?.getAttribute('data-line')).toBe('busy'));
    expect(said(f.container)).not.toContain('Builder');
    expect(said(f.container)).not.toContain(m.status.running);
    expect(line(f.container)?.textContent).toContain(ma.waiting.replace('{count}', '2'));
  });

  it('open: one row each, the waits counted once per participant, and the line says neither', async () => {
    const f = await mount(going());
    await open(f);
    const rows = [...(activity(f.container)?.querySelectorAll('[data-activity-role]') ?? [])];
    expect(rows.map((row) => row.getAttribute('data-activity-role'))).toEqual(['p2', 'p1', 'p3']);
    expect(rows[2]?.textContent).toContain(ma.waitingTurns.replace('{count}', '2'));
    expect(rows[1]?.textContent).toContain(m.status.waiting);
    // Only the one answering can be viewed.
    expect(rows[0]?.querySelector('button')).not.toBeNull();
    expect(rows[1]?.querySelector('button')).toBeNull();
    expect(said(f.container)).not.toContain('Builder');
    expect(line(f.container)?.textContent).not.toContain(ma.waiting.replace('{count}', '2'));
    // Stop, and no join, no pause.
    const panel = activity(f.container)?.textContent ?? '';
    expect(panel).toContain(messages.Activity.stop);
    expect(panel).not.toContain(messages.Activity.join);
    // No row is where an instruction goes.
    expect(panel).not.toContain(messages.Activity.joinTarget);
    expect(panel).not.toContain(messages.Activity.pause);
  });

  it('the secretary has its row by name', async () => {
    const f = await mount(
      view([
        round('r1', {
          kind: 'secretary',
          participantIds: [SECRETARY_ID],
          active: true,
          answers: [running(SECRETARY_ID)],
        }),
      ]),
    );
    await open(f);
    expect(
      activity(f.container)?.querySelector(`[data-activity-role="${SECRETARY_ID}"]`)?.textContent,
    ).toContain(m.secretary);
  });

  it('a long answer followed to its end, its head out of view: the line names who answers', async () => {
    // What is in an answer's head (its name and Answering…) is out of view; its body is in view.
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        readonly report: IntersectionObserverCallback;
        constructor(report: IntersectionObserverCallback) {
          this.report = report;
        }
        observe(target: Element) {
          const inView = !target.closest('header');
          queueMicrotask(() =>
            this.report(
              [
                {
                  target,
                  isIntersecting: inView,
                  intersectionRect: { height: inView ? 10 : 0 },
                } as never,
              ],
              this as never,
            ),
          );
        }
        unobserve() {}
        disconnect() {}
      },
    );
    const f = await mount(
      view([round('r1', { participantIds: ['p2'], active: true, answers: [running('p2')] })]),
    );
    await act(async () => {});
    expect(activity(f.container)?.getAttribute('data-line')).toBe('answering');
    expect(line(f.container)?.textContent).toContain('Builder');
  });

  it('the continue card is said by its head: with the head out of view, the line says it', async () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        readonly report: IntersectionObserverCallback;
        constructor(report: IntersectionObserverCallback) {
          this.report = report;
        }
        observe(target: Element) {
          const inView = !target.closest('header');
          queueMicrotask(() =>
            this.report(
              [
                {
                  target,
                  isIntersecting: inView,
                  intersectionRect: { height: inView ? 10 : 0 },
                } as never,
              ],
              this as never,
            ),
          );
        }
        unobserve() {}
        disconnect() {}
      },
    );
    const f = await mount(
      view([round('r1', { answers: [answered('p2')] })], {
        hold: { kind: 'chain', after: 'r1' },
      }),
    );
    await act(async () => {});
    expect(activity(f.container)?.getAttribute('data-line')).toBe('hold');
  });

  it('a hold out of view comes first; View goes to the card', async () => {
    const f = await mount(
      view([round('r1', { answers: [answered('p2')] })], {
        hold: { kind: 'chain', after: 'r1' },
      }),
    );
    expect(activity(f.container)?.getAttribute('data-line')).toBe('hold');
    expect(line(f.container)?.textContent).toContain(m.hold.heading);
    Element.prototype.scrollIntoView ??= () => {};
    await act(async () => viewButton(f.container)?.click());
    expect(document.activeElement).toBe(f.continueButton());
  });

  it('a hold on screen with nothing running: at rest', async () => {
    allInView();
    const f = await mount(
      view([round('r1', { answers: [answered('p2')] })], {
        hold: { kind: 'chain', after: 'r1' },
      }),
    );
    await vi.waitFor(() =>
      expect(activity(f.container)?.getAttribute('data-line')).toBe('summary'),
    );
    expect(said(f.container)).not.toContain(m.hold.heading);
    expect(said(f.container)).toContain('1 reply');
  });

  it('at rest: the last replies and failures, never the No reply of a message for no one', async () => {
    const f = await mount(
      view([
        round('r1', {
          participantIds: ['p1', 'p2'],
          answers: [answered('p1'), { ...answered('p2'), status: 'failed', text: null }],
        }),
        round('r2', {
          participantIds: [],
          answers: [],
          ...select({ strategy: 'none', reason: 'no_recipients' }),
        }),
      ]),
    );
    const words = line(f.container)?.textContent ?? '';
    expect(words).toContain('1 reply');
    expect(words).toContain(ma.failed.replace('{count}', '1'));
    expect(words).not.toContain(m.meta.noReply);
  });

  it('a round whose answers all failed: its failures alone', async () => {
    const f = await mount(
      view([
        round('r1', {
          participantIds: ['p1', 'p2'],
          answers: [
            { ...answered('p1'), status: 'failed', text: null },
            { ...answered('p2'), status: 'failed', text: null },
          ],
        }),
      ]),
    );
    const words = line(f.container)?.textContent ?? '';
    expect(words).toContain(ma.failed.replace('{count}', '2'));
    // No "0 replies".
    expect(words).not.toMatch(/repl/);
  });

  it('an empty meeting: the line is there, the same height, saying nothing', async () => {
    const f = await mount(view([]));
    expect(activity(f.container)?.getAttribute('data-line')).toBe('none');
    expect(line(f.container)?.textContent).toBe('');
    expect(line(f.container)?.className).toContain('h-8');
  });
});

describe('a stop leaves one line at the end, and no row for an answer that never started', () => {
  const items = (f: { container: HTMLElement }) =>
    [...f.container.querySelectorAll('[data-chat-item]')].map((node) =>
      node.getAttribute('data-chat-item'),
    );
  const never = (participantId: string, status: 'waiting' | 'stopped' | 'not_started') => ({
    ...answered(participantId),
    runId: null,
    status,
    text: null,
  });
  const at = (second: number) => `2026-11-14T00:00:${String(second).padStart(2, '0')}.000Z`;

  it('a note posted while a mention chain runs, then a stop: the line comes after the note', async () => {
    const r1 = round('r1', {
      order: 0,
      createdAt: at(0),
      answers: [{ ...answered('p1'), order: 1 }],
    });
    const chain = (answers: Round['answers'], stoppedAt: string | null = null) =>
      round('r2', {
        kind: 'mention',
        message: null,
        order: 2,
        createdAt: at(1),
        participantIds: ['p2', 'p3'],
        active: stoppedAt === null,
        stoppedAt,
        answers,
      });
    const note = round('r3', {
      message: 'A note for no one',
      order: 4,
      createdAt: at(2),
      participantIds: [],
      answers: [],
      ...select({ strategy: 'none', reason: 'no_recipients' }),
    });
    const f = await mount(
      view([r1, chain([{ ...running('p2'), order: 3 }, never('p3', 'waiting')]), note]),
    );
    const before = items(f);
    expect(before).toEqual(['r1:message', 'r1:p1', 'r2:p2', 'r3:message']);
    await f.refresh(
      view([
        r1,
        chain([{ ...running('p2'), status: 'stopped', order: 3 }, never('p3', 'stopped')], at(3)),
        note,
      ]),
    );
    // Nothing moved in above; the one who never started has no row; one line, at the end.
    expect(items(f)).toEqual([...before, 'r2:stopped']);
  });

  it('a question, a follow-up while it is answered, then a stop: one line, after the follow-up', async () => {
    const first = (answers: Round['answers'], stoppedAt: string | null = null) =>
      round('r1', {
        order: 0,
        createdAt: at(0),
        participantIds: ['p1', 'p2'],
        active: stoppedAt === null,
        stoppedAt,
        answers,
      });
    const follow = (answers: Round['answers'], stoppedAt: string | null = null) =>
      round('r2', {
        message: 'And the second part?',
        order: 2,
        createdAt: at(1),
        participantIds: ['p2'],
        active: stoppedAt === null,
        stoppedAt,
        answers,
      });
    const f = await mount(
      view([
        first([{ ...running('p1'), order: 1 }, never('p2', 'waiting')]),
        follow([never('p2', 'waiting')]),
      ]),
    );
    const before = items(f);
    expect(before).toEqual(['r1:message', 'r1:p1', 'r2:message']);
    // One stop, two messages stopped with it (their stop times a moment apart).
    await f.refresh(
      view([
        first([{ ...running('p1'), status: 'stopped', order: 1 }, never('p2', 'stopped')], at(3)),
        follow([never('p2', 'stopped')], '2026-11-14T00:00:03.001Z'),
      ]),
    );
    expect(items(f)).toEqual([...before, 'r1:stopped']);
  });

  it('a mention of three stopped with one answering: only that one has a row', async () => {
    const f = await mount(
      view([
        round('r1', {
          order: 0,
          createdAt: at(0),
          participantIds: ['p1', 'p2', 'p3'],
          stoppedAt: at(1),
          answers: [
            { ...running('p1'), status: 'stopped', order: 1 },
            never('p2', 'stopped'),
            never('p3', 'not_started'),
          ],
        }),
      ]),
    );
    expect(items(f)).toEqual(['r1:message', 'r1:p1', 'r1:stopped']);
  });

  it('a later stop has its own line at its end; the earlier one stays where it was', async () => {
    const f = await mount(
      view([
        round('r1', {
          order: 0,
          createdAt: at(0),
          stoppedAt: at(1),
          answers: [{ ...running('p2'), status: 'stopped', order: 1 }],
        }),
        round('r2', {
          order: 2,
          createdAt: at(2),
          stoppedAt: at(3),
          answers: [{ ...running('p2'), status: 'stopped', order: 3 }],
        }),
      ]),
    );
    expect(items(f)).toEqual([
      'r1:message',
      'r1:p2',
      'r1:stopped',
      'r2:message',
      'r2:p2',
      'r2:stopped',
    ]);
  });
});
