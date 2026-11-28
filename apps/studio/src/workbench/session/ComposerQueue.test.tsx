// @vitest-environment jsdom
import { createTextAttachment, type SessionEntry } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ComposerQueue } from './ComposerQueue.tsx';

const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
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
});
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

const entry = (entryId: string, text: string, extra: Partial<SessionEntry> = {}): SessionEntry => ({
  entryId,
  intent: 'queue',
  text,
  state: 'queued',
  createdAt: '2026-11-09T00:00:00Z',
  runId: null,
  executionId: null,
  detail: null,
  ...extra,
});

async function mount(
  queued: SessionEntry[],
  startDisabled = false,
  {
    running = false,
    autoStart = false,
    autoStartShown = true,
  }: { running?: boolean; autoStart?: boolean; autoStartShown?: boolean } = {},
) {
  const handlers = {
    onStart: vi.fn(),
    onEdit: vi.fn(),
    onRemove: vi.fn(),
    onAutoStartChange: vi.fn(),
  };
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
        <ComposerQueue
          queued={queued}
          autoStart={autoStart}
          autoStartShown={autoStartShown}
          running={running}
          startDisabled={startDisabled}
          {...handlers}
        />
      </IntlProvider>,
    ),
  );
  const buttons = (name: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
      (button) => button.getAttribute('aria-label') === name || button.textContent === name,
    );
  return { container, handlers, buttons };
}

it('stacks saved requests in the kit queue without drag reordering', async () => {
  const first = entry('first', 'Summarize the report');
  const second = entry('second', 'Then draft the reply', {
    attachments: [createTextAttachment('notes.txt', 'text/plain', 'Keep it short.')],
  });
  const view = await mount([first, second]);
  const region = view.container.querySelector('section');
  expect(region?.getAttribute('aria-label')).toBe(messages.Sessions.queueHeading);
  expect(region?.textContent).toContain('Summarize the report');
  expect(region?.textContent).toContain('Then draft the reply');
  // The kit stack, not the old list: one card per saved request.
  const cards = view.container.querySelectorAll('.group\\/qm');
  expect(cards).toHaveLength(2);
  // Hovering fans the cards out; without a reorder handler they never become draggable.
  const stack = cards[0]?.parentElement?.parentElement;
  await act(async () => stack?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  for (const card of cards) {
    expect((card as HTMLElement).style.cursor).not.toBe('grab');
    expect((card as HTMLElement).style.touchAction).not.toBe('none');
  }
  expect(region?.querySelectorAll('li')).toHaveLength(0);
  // The switch keeps its label and hint.
  const toggle = view.container.querySelector('[role="switch"]');
  expect(toggle).not.toBeNull();
  expect(view.container.textContent).toContain(messages.Sessions.autoStart);
  expect(
    view.container.querySelector(`[title="${messages.Sessions.autoStartHint}"]`),
  ).not.toBeNull();
});

it('shows a saved request’s images as file tiles, as its text attachments', async () => {
  const image = {
    kind: 'image_attachment' as const,
    imageId: 'img_0123456789abcdef',
    name: 'screen.png',
    mime: 'image/png' as const,
    bytes: 120,
    sha256: 'a'.repeat(64),
    width: 10,
    height: 10,
  };
  const view = await mount([
    entry('first', 'Look at this', {
      attachments: [createTextAttachment('notes.txt', 'text/plain', 'Keep it short.')],
      images: [image],
    }),
  ]);
  const tiles = [...view.container.querySelectorAll('.group\\/qm [role="img"]')].map((node) =>
    node.getAttribute('aria-label'),
  );
  expect(tiles).toEqual(['notes.txt', 'screen.png']);
  // The tile has no bytes to show, so it is the file glyph, never an empty picture.
  expect(view.container.querySelector('.group\\/qm img')).toBeNull();
});

it('Start now, Edit and Remove call the existing handlers with the saved entry', async () => {
  const first = entry('first', 'Summarize the report');
  const view = await mount([first]);
  const [start] = view.buttons(messages.Sessions.startNow);
  expect(start?.disabled).toBe(false);
  await act(async () => start?.click());
  expect(view.handlers.onStart).toHaveBeenCalledWith(first);
  const [edit] = view.buttons('Edit queued request: Summarize the report');
  await act(async () => edit?.click());
  expect(view.handlers.onEdit).toHaveBeenCalledWith(first);
  const [remove] = view.buttons('Remove queued request: Summarize the report');
  await act(async () => remove?.click());
  expect(view.handlers.onRemove).toHaveBeenCalledWith(first);
  // Pressing the host action never also edits the card.
  expect(view.handlers.onEdit).toHaveBeenCalledOnce();
});

it('keeps Start now disabled under the existing condition', async () => {
  const view = await mount([entry('first', 'Summarize the report')], true);
  const [start] = view.buttons(messages.Sessions.startNow);
  expect(start?.disabled).toBe(true);
  await act(async () => start?.click());
  expect(view.handlers.onStart).not.toHaveBeenCalled();
});

describe('Start now while a run is going (composer-flow.md: queued requests and handover)', () => {
  const saved = () => entry('first', 'Summarize the report');
  const resend = () =>
    entry('resend', 'Summarize the report', {
      resend: { of: 'sent', runId: 'run_failed', notBefore: '2026-11-25T10:43:00.000Z' },
    });
  const startAfterRun = messages.Sessions.startAfterRun;

  it('with auto start on, the place is empty: the switch already says when it starts', async () => {
    const view = await mount([saved()], false, { running: true, autoStart: true });
    expect(view.buttons(messages.Sessions.startNow)).toHaveLength(0);
    expect(startAfterRun).toBeTruthy();
    expect(view.container.textContent).not.toContain(startAfterRun);
  });

  it('with auto start on, a resend keeps its time and nothing else', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-25T09:00:00.000Z'), toFake: ['Date'] });
    const view = await mount([resend()], false, { running: true, autoStart: true });
    expect(view.container.textContent).toContain('Resends at 10:43');
    expect(view.buttons(messages.Sessions.startNow)).toHaveLength(0);
    expect(view.container.textContent).not.toContain(startAfterRun);
    vi.useRealTimers();
  });

  it('with auto start off, one line says it can start when the run ends', async () => {
    const view = await mount([saved()], false, { running: true, autoStart: false });
    expect(view.buttons(messages.Sessions.startNow)).toHaveLength(0);
    const line = [...view.container.querySelectorAll('span')].find(
      (node) => node.textContent === startAfterRun && node.childElementCount === 0,
    );
    expect(line?.className).toContain('text-caption');
    expect(line?.className).toContain('text-muted-foreground');
  });

  it('with auto start off, a resend shows its time and the line', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-25T09:00:00.000Z'), toFake: ['Date'] });
    const view = await mount([resend()], false, { running: true, autoStart: false });
    expect(view.container.textContent).toContain('Resends at 10:43');
    expect(view.container.textContent).toContain(startAfterRun);
    expect(view.buttons(messages.Sessions.startNow)).toHaveLength(0);
    vi.useRealTimers();
  });

  it('the browser demo has no switch, so it shows the line even with auto start on', async () => {
    const view = await mount([saved()], false, {
      running: true,
      autoStart: true,
      autoStartShown: false,
    });
    expect(view.container.querySelector('[role="switch"]')).toBeNull();
    expect(view.buttons(messages.Sessions.startNow)).toHaveLength(0);
    expect(view.container.textContent).toContain(startAfterRun);
  });

  it('without a run, a start being sent keeps the disabled button and no line', async () => {
    const view = await mount([saved()], true, { running: false, autoStart: false });
    const [start] = view.buttons(messages.Sessions.startNow);
    expect(start?.disabled).toBe(true);
    expect(view.container.textContent).not.toContain(startAfterRun);
  });

  it('without a run, Start now can be pressed and there is no line', async () => {
    const view = await mount([saved()], false, { running: false, autoStart: true });
    const [start] = view.buttons(messages.Sessions.startNow);
    expect(start?.disabled).toBe(false);
    await act(async () => start?.click());
    expect(view.handlers.onStart).toHaveBeenCalledOnce();
    expect(view.container.textContent).not.toContain(startAfterRun);
  });
});

it('renders nothing without saved requests', async () => {
  const view = await mount([]);
  expect(view.container.querySelector('section')).toBeNull();
});

it('shows when a request that failed on a usage limit is sent again, and still starts now', async () => {
  // features/usage-limit-resend.md
  const resend = entry('resend', 'Summarize the report', {
    resend: { of: 'sent', runId: 'run_failed', notBefore: '2026-11-25T10:43:00.000Z' },
  });
  vi.useFakeTimers({ now: new Date('2026-11-25T09:00:00.000Z'), toFake: ['Date'] });
  const view = await mount([resend]);
  expect(view.container.textContent).toContain('Resends at 10:43');
  expect(view.container.textContent).not.toContain('11/25');
  const [start] = view.buttons(messages.Sessions.startNow);
  await act(async () => start?.click());
  expect(view.handlers.onStart).toHaveBeenCalledWith(resend);
  vi.useRealTimers();
});

it('names the day of a resend that is not today', async () => {
  vi.useFakeTimers({ now: new Date('2026-11-25T09:00:00.000Z'), toFake: ['Date'] });
  const view = await mount([
    entry('resend', 'Weekly limit', {
      resend: { of: 'sent', runId: 'run_failed', notBefore: '2026-11-28T10:43:00.000Z' },
    }),
  ]);
  expect(view.container.textContent).toContain('Resends at 11/28/26, 10:43');
  vi.useRealTimers();
});
