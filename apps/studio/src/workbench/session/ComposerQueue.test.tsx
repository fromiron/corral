// @vitest-environment jsdom
import { createTextAttachment, type SessionEntry } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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

async function mount(queued: SessionEntry[], startDisabled = false) {
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
          autoStart={false}
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

it('renders nothing without saved requests', async () => {
  const view = await mount([]);
  expect(view.container.querySelector('section')).toBeNull();
});
