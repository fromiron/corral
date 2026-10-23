// @vitest-environment jsdom
import type { MeetingRoundRequest, MeetingView } from '@corral/contracts';
import type { WorkSession } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const translate = vi.hoisted(() => (key: string) => key);
const services = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('use-intl', () => ({ useTranslations: () => translate }));
vi.mock('../services.tsx', () => ({ useServices: () => services.current }));
vi.mock('../workbench/useModels.ts', () => ({ useModelProfiles: () => null }));
vi.mock('../workbench/MeetingEvidence.tsx', () => ({
  MeetingEvidencePicker: ({ value, onChange }: any) => (
    <button
      type="button"
      onClick={() =>
        onChange([
          ...value,
          {
            name: 'brief.txt',
            text: 'Selected evidence',
            bytes: 17,
            mime: 'text/plain',
            sha256: 'a'.repeat(64),
          },
        ])
      }
    >
      attachEvidence
    </button>
  ),
}));
vi.mock('../workbench/ChatView.tsx', () => ({
  ChatView: ({ items, composer, header, children }: any) => (
    <div>
      {header}
      {children}
      {items.map((item: any) => (
        <div key={item.id}>{item.content}</div>
      ))}
      {composer}
    </div>
  ),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: any) => <a href="#run">{children}</a>,
}));
vi.mock('@corral/react', () => ({ SafeMarkdown: ({ text }: any) => <p>{text}</p> }));
vi.mock('@corral/react/ui', () => ({
  Button: ({ children, variant: _v, size: _s, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
}));

const { MeetingPage } = await import('./MeetingPage.tsx');

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
});

async function mount(current: MeetingView) {
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
  services.current = { meetings, mode: 'browser', live: false };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const session = { sessionId: 'session_1', title: 'Review' } as WorkSession;
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
  return { container, meetings, button, box, type };
}

it('[TC-MEET-001-H] shows each answer in participant order with its state and usage, and sends with mentions', async () => {
  const f = await mount(view());
  const articles = [...f.container.querySelectorAll('article')].map((a) =>
    a.getAttribute('aria-label'),
  );
  expect(articles).toEqual(['Architect', 'Builder']);
  expect(f.container.textContent).toContain('p1 says yes');
  expect(f.container.textContent).toContain('status.failed');
  expect(f.container.textContent).toContain('provider unavailable');
  expect(f.container.textContent).toContain('usageUnknown');
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
  await act(async () => f.button('rebuttal')?.click());
  expect(f.meetings.send).toHaveBeenLastCalledWith(
    'session_1',
    expect.objectContaining({ kind: 'rebuttal' }),
  );
});

it('[TC-MEET-001-N] Enter while composing with an IME does not send, and a lost answer keeps its command ID', async () => {
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

it('[TC-MEET-001-F] a running round can be stopped and a waiting message is shown, sendable only when idle', async () => {
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
  expect(f.button('rebuttal')?.disabled).toBe(true);
  expect(f.button('sendQueued')).toBeUndefined();
  expect(f.container.textContent).toContain('next question');
  await act(async () => f.button('stopRound')?.click());
  expect(f.meetings.stop).toHaveBeenCalledWith('session_1', 'round_1');
  await act(async () => f.button('dropQueued')?.click());
  expect(f.meetings.dropQueued).toHaveBeenCalledWith('session_1');
});

it('[TC-MEET-001-N] /반론 is sent to the round service and an uncertain retry keeps its command ID', async () => {
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

it('[TC-MEET-001-N] a full queue blocks Enter and editing updates that queued command only', async () => {
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
  expect(f.meetings.send).not.toHaveBeenCalled();
  expect(f.button('editQueued')).toBeDefined();
  await act(async () => f.button('editQueued')?.click());
  const queuedBox = f.container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="queued"]',
  )!;
  const queuedButton = (label: string) =>
    [...queuedBox.parentElement!.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === label,
    );
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

it('[TC-MEET-001-F] a stopped round is identified even when completed answers are retained', async () => {
  const f = await mount(
    view({ rounds: [{ ...view().rounds[0]!, stoppedAt: '2026-10-23T00:00:00Z' }] }),
  );
  expect(f.container.textContent).toContain('roundStopped');
  expect(f.container.textContent).toContain('p1 says yes');
});

it('[TC-MEET-001-N] asking the secretary to summarise preserves the unsent draft', async () => {
  const f = await mount(view());
  await f.type('Do not erase this question');
  await act(async () => f.button('summarise')?.click());
  expect(f.box.value).toBe('Do not erase this question');
  expect(f.meetings.send).toHaveBeenCalledWith(
    'session_1',
    expect.objectContaining({ mentions: ['secretary'] }),
  );
});

it('[TC-MEET-001-H] only explicitly attached evidence is sent, and a failed send preserves it', async () => {
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

it('[TC-MEET-001-F] a late refresh cannot replace a newer round view', async () => {
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

it('[TC-MEET-001-F] slow polling waits for the pending response before requesting another', async () => {
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

it('[TC-MEET-002-H] parsed secretary minutes open the records panel instead of displaying their storage JSON', async () => {
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
  expect(f.container.querySelector('details')?.open).toBe(true);
  expect(document.activeElement?.tagName).toBe('SUMMARY');
});

it('[TC-MEET-002-F] an unparsed secretary answer stays available for recovery', async () => {
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
