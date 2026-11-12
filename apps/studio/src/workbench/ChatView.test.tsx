// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ChatView } from './ChatView.tsx';

const resizeCallbacks = new Set<(entries?: unknown) => void>();
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

async function render(
  aside?: React.ReactNode,
  expandedHeader = false,
  messageId?: string,
  itemContent: React.ReactNode = <p>reply</p>,
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(privateCallback: () => void) {
        this.callback = privateCallback;
        resizeCallbacks.add(privateCallback);
      }
      callback: () => void;
      observe() {}
      unobserve() {}
      disconnect() {
        resizeCallbacks.delete(this.callback);
      }
    },
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ChatView
          sessionId="session"
          messageId={messageId}
          header={<p>Meeting records</p>}
          expandedHeader={expandedHeader}
          items={[{ id: 'entry', content: itemContent }]}
          composer={<textarea aria-label="request" />}
          aside={aside}
        />
      </IntlProvider>,
    ),
  );
  return container;
}

it('Overview floats over the conversation view without splitting it', async () => {
  const plain = await render();
  const layout = (root: Element) =>
    [...(root.querySelector('[data-chat-view]')?.children ?? [])]
      .filter((child) => child.getAttribute('data-testid') !== 'chat-overview')
      .map((child) => child.getAttribute('data-testid'));
  const without = layout(plain);
  const container = await render(<div data-testid="widgets">widgets</div>);
  // The view itself is the root: no frame divides its width with a second column.
  expect(container.firstElementChild?.hasAttribute('data-chat-view')).toBe(true);
  expect(layout(container)).toEqual(without);
  const widgets = container.querySelector('[data-testid="chat-overview"]');
  expect(widgets?.parentElement?.hasAttribute('data-chat-view')).toBe(true);
  expect(widgets?.querySelector('[data-testid="widgets"]')).not.toBeNull();
  // Outside the scrolling timeline, so the widgets stay put while the conversation scrolls.
  expect(widgets?.closest('[data-testid="chat-timeline"]')).toBeNull();
  expect(widgets?.closest('[data-testid="chat-composer"]')).toBeNull();
});

it('a conversation without Overview has no widgets', async () => {
  const container = await render();
  expect(container.querySelector('[data-testid="chat-overview"]')).toBeNull();
});

it('keeps explicitly opened Overview available at every conversation width', () => {
  const css = readFileSync(join(import.meta.dirname, '..', 'index.css'), 'utf8');
  const rule = (selector: string) =>
    css.match(
      new RegExp(`(?:^|\\n)${selector.replace(/[.[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`),
    )?.[1] ?? '';
  // The view measures itself; the widgets float over it, sized to the margin beside the
  // centered conversation, and are hidden by default (and while empty).
  expect(rule('[data-chat-view]')).toMatch(/container:\s*chat-view \/ inline-size/);
  const widgets = rule('.chat-overview');
  expect(widgets).toMatch(/position:\s*absolute/);
  expect(widgets).toMatch(/display:\s*none/);
  expect(widgets).toMatch(/100cqw - var\(--chat-content-max-width\)\) \/ 2/);
  expect(css).toMatch(
    /@container chat-view \(min-width: 75rem\)\s*\{\s*\.chat-overview:not\(:empty\)\s*\{\s*display:\s*flex;/,
  );
  // The actual session no longer mounts floating widgets; its explicit entry remains available.
  expect(rule('.session-widget-access')).toMatch(/display:\s*flex/);
});

it('follows growing replies, keeps following after a message click, and pauses for manual scroll until Latest', async () => {
  sessionStorage.clear();
  const container = await render();
  const box = container.querySelector<HTMLElement>('[data-testid="chat-timeline"]')!;
  const row = container.querySelector<HTMLElement>('[data-chat-item]')!;
  let height = 500;
  let top = 0;
  Object.defineProperties(box, {
    scrollHeight: { get: () => height },
    clientHeight: { get: () => 200 },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, height - 200));
      },
    },
  });
  row.getBoundingClientRect = () => ({ top: -top, bottom: height - top }) as DOMRect;
  const resize = async () =>
    act(async () => {
      for (const callback of resizeCallbacks) callback();
    });
  await resize();
  expect(top).toBe(300);
  row.querySelector('p')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  height = 700;
  await resize();
  expect(top).toBe(500);
  await act(async () => {
    box.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -80 }));
    box.scrollTop = 100;
    box.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  height = 1000;
  await resize();
  expect(top).toBe(100);
  const latest = [...container.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === 'Jump to latest',
  )!;
  await act(async () => latest.click());
  expect(top).toBe(800);
  height = 1200;
  await resize();
  expect(top).toBe(1000);
});

it('keeps following when the reply grows between its own scroll to the end and that scroll’s event', async () => {
  sessionStorage.clear();
  const container = await render();
  const box = container.querySelector<HTMLElement>('[data-testid="chat-timeline"]');
  const row = container.querySelector<HTMLElement>('[data-chat-item]');
  if (!box || !row) throw new Error('Conversation fixture missing');
  let height = 500;
  let top = 0;
  Object.defineProperties(box, {
    scrollHeight: { get: () => height },
    clientHeight: { get: () => 200 },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, height - 200));
      },
    },
  });
  row.getBoundingClientRect = () => ({ top: -top, bottom: height - top }) as DOMRect;
  const resize = async () =>
    act(async () => {
      for (const callback of resizeCallbacks) callback();
    });
  await resize();
  expect(top).toBe(300);
  // The browser dispatches the view's own scroll after the turn has grown again (a card's
  // footer, the next words): the reader did not leave the end.
  height = 668;
  await act(async () => box.dispatchEvent(new Event('scroll', { bubbles: true })));
  await resize();
  expect(top).toBe(468);
  // Dragging the scrollbar up still stops following.
  await act(async () => {
    box.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    box.scrollTop = 100;
    box.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  height = 900;
  await resize();
  expect(top).toBe(100);
});

it('expanded records use the reading area while retaining the composer and mounted conversation', async () => {
  const container = await render(undefined, true);
  const timeline = container.querySelector<HTMLElement>('[data-testid="chat-timeline"]');
  expect(timeline?.hidden).toBe(true);
  expect(timeline?.textContent).toContain('reply');
  expect(container.querySelector('textarea[aria-label="request"]')?.closest('[hidden]')).toBeNull();
  // The records being read stay outside the hidden timeline.
  const records = [...container.querySelectorAll('p')].find(
    (node) => node.textContent === 'Meeting records',
  );
  expect(records?.closest('[data-testid="chat-timeline"]')).toBeNull();
});

it('a notice is part of the conversation flow: it scrolls with the messages and never covers them', async () => {
  const container = await render();
  const notice = [...container.querySelectorAll('p')].find(
    (node) => node.textContent === 'Meeting records',
  );
  const timeline = container.querySelector('[data-testid="chat-timeline"]');
  const row = container.querySelector('[data-chat-item="entry"]');
  expect(notice && timeline?.contains(notice)).toBe(true);
  // It comes before the first message, in the same scrolling content.
  expect(
    notice && row ? notice.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING : 0,
  ).toBeTruthy();
  // The newest row is marked, so its answer keeps its actions in view.
  expect(row?.hasAttribute('data-latest')).toBe(true);
});

it('keeps an older message action in place when pointer focus precedes its scroll event', async () => {
  sessionStorage.clear();
  const container = await render(
    undefined,
    false,
    undefined,
    <button type="button">Retry request</button>,
  );
  const box = container.querySelector<HTMLElement>('[data-testid="chat-timeline"]');
  const row = container.querySelector<HTMLElement>('[data-chat-item]');
  const action = row?.querySelector('button');
  if (!box || !row || !action) throw new Error('Conversation action fixture missing');
  let height = 1000;
  let top = 0;
  Object.defineProperties(box, {
    scrollHeight: { get: () => height },
    clientHeight: { get: () => 200 },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, height - 200));
      },
    },
  });
  row.getBoundingClientRect = () => ({ top: -top, bottom: height - top }) as DOMRect;
  const resize = async () =>
    act(async () => {
      for (const callback of resizeCallbacks) callback();
    });
  await resize();
  expect(top).toBe(800);
  // Browser hit testing scrolls the older action into view before pointerdown.
  // Its queued scroll event has not run when focus triggers a React render.
  box.scrollTop = 100;
  await act(async () => {
    action.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    action.focus();
  });
  expect(document.activeElement).toBe(action);
  expect(top).toBe(100);
  height = 1200;
  await resize();
  expect(top).toBe(100);
});

// The same guarantee when the conversation is only a little taller than its view: moving up by
// less than the distance that counts as "near the end" still leaves the end, or the view would
// pull a clipped older action back out from under the pointer.
it('keeps an older message action in place when the conversation overflows by less than the follow distance', async () => {
  sessionStorage.clear();
  const container = await render(
    undefined,
    false,
    undefined,
    <button type="button">Open in Results</button>,
  );
  const box = container.querySelector<HTMLElement>('[data-testid="chat-timeline"]');
  const row = container.querySelector<HTMLElement>('[data-chat-item]');
  const action = row?.querySelector('button');
  if (!box || !row || !action) throw new Error('Conversation action fixture missing');
  let height = 227;
  let top = 0;
  Object.defineProperties(box, {
    scrollHeight: { get: () => height },
    clientHeight: { get: () => 200 },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, height - 200));
      },
    },
  });
  row.getBoundingClientRect = () => ({ top: -top, bottom: height - top }) as DOMRect;
  const resize = async () =>
    act(async () => {
      for (const callback of resizeCallbacks) callback();
    });
  await resize();
  expect(top).toBe(27);
  // The browser scrolls the clipped action into view, then the pointer goes down on it.
  box.scrollTop = 0;
  await act(async () => {
    box.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await act(async () => {
    action.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    action.focus();
  });
  expect(top).toBe(0);
  await resize();
  expect(top).toBe(0);
  // Scrolling back down to the end follows again.
  await act(async () => {
    box.dispatchEvent(new Event('wheel', { bubbles: true }));
    box.scrollTop = 27;
    box.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  height = 400;
  await resize();
  expect(top).toBe(200);
});

it('identifies and highlights the message selected from search', async () => {
  const container = await render(undefined, false, 'entry');
  const row = container.querySelector('[data-chat-item="entry"]');
  expect(row?.getAttribute('aria-current')).toBe('location');
  expect(row?.className).toContain('ring-focus-ring');
});

it('returns to the same search hit after leaving its link and reading elsewhere', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const resizeCallbacks = new Set<() => void>();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
        resizeCallbacks.add(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {
        resizeCallbacks.delete(this.callback);
      }
    },
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const show = async (messageId?: string) =>
    act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ChatView
            sessionId="repeated-search"
            messageId={messageId}
            items={[{ id: 'entry', content: <p>Search result</p> }]}
            composer={<textarea aria-label="request" />}
          />
        </IntlProvider>,
      ),
    );
  await show('entry');
  const box = container.querySelector<HTMLElement>('[data-testid="chat-timeline"]');
  const row = container.querySelector<HTMLElement>('[data-chat-item="entry"]');
  if (!box || !row) throw new Error('Conversation fixture missing');
  let top = 0;
  Object.defineProperties(box, {
    scrollHeight: { get: () => 1000 },
    clientHeight: { get: () => 200 },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = value;
      },
    },
  });
  box.getBoundingClientRect = () => ({ top: 0, bottom: 200 }) as DOMRect;
  row.getBoundingClientRect = () => ({ top: 600 - top, bottom: 660 - top }) as DOMRect;
  const resize = async () =>
    act(async () => {
      for (const callback of resizeCallbacks) callback();
    });
  await resize();
  expect(top).toBe(600);
  await show();
  await act(async () => {
    box.dispatchEvent(new Event('wheel', { bubbles: true }));
    box.scrollTop = 50;
    box.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await show('entry');
  await resize();
  expect(top).toBe(600);
  expect(row.getAttribute('aria-current')).toBe('location');
});

/**
 * A conversation whose scroll port the test owns, so a send, a growing turn, a composer
 * resizing the port, and a virtual list can be told apart from a person scrolling up.
 */
async function mountConversation(initial: {
  items: { id: string; content: React.ReactNode }[];
  sent?: number;
}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      callback: (..._args: unknown[]) => void;
      constructor(callback: (...args: unknown[]) => void) {
        this.callback = callback;
        resizeCallbacks.add(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {
        resizeCallbacks.delete(this.callback);
      }
    },
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  // The virtual list reads the port's offset box, which jsdom leaves at 0, and then paints nothing.
  const elementProto = HTMLElement.prototype;
  const offsetHeight = Object.getOwnPropertyDescriptor(elementProto, 'offsetHeight');
  const offsetWidth = Object.getOwnPropertyDescriptor(elementProto, 'offsetWidth');
  Object.defineProperty(elementProto, 'offsetHeight', { configurable: true, get: () => 200 });
  Object.defineProperty(elementProto, 'offsetWidth', { configurable: true, get: () => 480 });
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
    if (offsetHeight) Object.defineProperty(elementProto, 'offsetHeight', offsetHeight);
    if (offsetWidth) Object.defineProperty(elementProto, 'offsetWidth', offsetWidth);
  });
  let sent = initial.sent ?? 0;
  let items = initial.items;
  const draw = () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ChatView
          sessionId="session-follow"
          sent={sent}
          items={items}
          composer={<textarea aria-label="request" />}
        />
      </IntlProvider>,
    );
  await act(draw);
  const box = container.querySelector<HTMLElement>('[data-testid="chat-timeline"]');
  if (!box) throw new Error('Conversation fixture missing');
  const metrics = { height: 800, client: 200 };
  let top = 0;
  Object.defineProperties(box, {
    scrollHeight: { configurable: true, get: () => metrics.height },
    clientHeight: { configurable: true, get: () => metrics.client },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(value, Math.max(0, metrics.height - metrics.client)));
      },
    },
  });
  box.scrollTo = ((options?: ScrollToOptions | number) => {
    box.scrollTop = typeof options === 'number' ? options : (options?.top ?? top);
  }) as HTMLElement['scrollTo'];
  const resize = () =>
    act(async () => {
      for (const callback of [...resizeCallbacks]) callback([]);
    });
  const update = async (next: { items?: typeof items; sent?: number }) => {
    if (next.items) items = next.items;
    if (next.sent !== undefined) sent = next.sent;
    await act(draw);
  };
  return {
    container,
    box,
    metrics,
    resize,
    update,
    get top() {
      return top;
    },
    set top(value: number) {
      top = value;
    },
    end: () => metrics.height - metrics.client,
  };
}

function liveTurn(tools: string[], text: string) {
  return [
    {
      id: 'turn-live',
      content: (
        <div>
          <p>Send the follow-up</p>
          {tools.map((tool) => (
            <div key={tool} data-testid="tool-row">
              {tool}
            </div>
          ))}
          <p data-testid="streamed-text">{text}</p>
        </div>
      ),
    },
  ];
}

it('sending a message follows the end again after reading earlier messages', async () => {
  sessionStorage.clear();
  const chat = await mountConversation({
    items: [
      { id: 'turn-0', content: <p>Earlier</p> },
      { id: 'turn-1', content: <p>Also earlier</p> },
    ],
  });
  await chat.resize();
  expect(chat.top).toBe(chat.end());
  await act(async () => {
    chat.box.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -80 }));
    chat.top = 40;
    chat.box.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  chat.metrics.height += 420;
  await chat.update({
    sent: 1,
    items: [
      { id: 'turn-0', content: <p>Earlier</p> },
      { id: 'turn-1', content: <p>Also earlier</p> },
      ...liveTurn(['read'], 'Starting'),
    ],
  });
  await chat.resize();
  expect(chat.top).toBe(chat.end());
});

it('keeps the end while tool rows and streamed text grow and the composer changes height', async () => {
  sessionStorage.clear();
  const chat = await mountConversation({ items: liveTurn([], '…') });
  await chat.resize();
  expect(chat.top).toBe(chat.end());
  await chat.update({ sent: 1, items: liveTurn(['read'], 'First words') });
  chat.metrics.height += 220;
  await chat.resize();
  expect(chat.top).toBe(chat.end());
  // The browser anchors the port upward as rows are measured. The person did not scroll.
  chat.top = chat.top - 90;
  await act(async () => {
    chat.box.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  // The composer grew, so the timeline's viewport shrank.
  chat.metrics.client -= 48;
  chat.metrics.height += 360;
  await chat.update({
    items: liveTurn(['read', 'bash'], 'First words and the rest of the sentence still arriving'),
  });
  await chat.resize();
  expect(chat.top).toBe(chat.end());
  expect(chat.container.querySelectorAll('[data-testid="tool-row"]')).toHaveLength(2);
  expect(chat.container.querySelector('[data-testid="streamed-text"]')?.textContent).toContain(
    'still arriving',
  );
});

it('keeps the end of a virtualized conversation while a sent turn grows', async () => {
  sessionStorage.clear();
  const history = (tools: string[], text: string) => [
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `turn-${index}`,
      content: <p>History {index}</p>,
    })),
    ...liveTurn(tools, text),
  ];
  const chat = await mountConversation({ items: history([], '') });
  await chat.resize();
  expect(chat.container.querySelectorAll('[data-chat-item]').length).toBeGreaterThan(0);
  expect(chat.top).toBe(chat.end());
  await chat.update({ sent: 1, items: history(['read'], 'partial') });
  chat.metrics.height += 500;
  chat.top = chat.top - 120;
  await act(async () => {
    chat.box.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  chat.metrics.client -= 32;
  chat.metrics.height += 280;
  await chat.update({
    items: history(['read', 'edit'], 'partial and more streamed text'),
  });
  await chat.resize();
  expect(chat.top).toBe(chat.end());
});

it('a downward wheel does not stop following the end', async () => {
  sessionStorage.clear();
  const chat = await mountConversation({
    items: [{ id: 'turn-0', content: <p data-testid="streamed-text">words</p> }],
  });
  await chat.resize();
  await act(async () => {
    chat.box.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 140 }));
  });
  chat.metrics.height += 300;
  await chat.resize();
  expect(chat.top).toBe(chat.end());
});

it('a layout-caused scroll offset decrease does not stop following the end', async () => {
  sessionStorage.clear();
  const chat = await mountConversation({
    items: [{ id: 'turn-0', content: <p data-testid="streamed-text">words</p> }],
  });
  await chat.resize();
  expect(chat.top).toBe(chat.end());
  chat.top = chat.end() - 70;
  await act(async () => {
    chat.box.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  chat.metrics.height += 250;
  await chat.resize();
  expect(chat.top).toBe(chat.end());
});

it('a scrollbar released outside the conversation does not let layout stop following', async () => {
  sessionStorage.clear();
  const chat = await mountConversation({
    items: [{ id: 'turn-0', content: <p data-testid="streamed-text">words</p> }],
  });
  await chat.resize();
  await act(async () => {
    chat.box.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    document.body.dispatchEvent(new Event('pointerup', { bubbles: true }));
  });
  chat.top = chat.end() - 70;
  await act(async () => {
    chat.box.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  chat.metrics.height += 250;
  await chat.resize();
  expect(chat.top).toBe(chat.end());
});

it('an upward wheel over a nested box stops following only once that box is at its top', async () => {
  sessionStorage.clear();
  const chat = await mountConversation({
    items: [
      {
        id: 'turn-0',
        content: (
          <div data-testid="nested" style={{ overflowY: 'auto' }}>
            long reply
          </div>
        ),
      },
    ],
  });
  await chat.resize();
  const nested = chat.container.querySelector<HTMLElement>('[data-testid="nested"]');
  if (!nested) throw new Error('Nested box missing');
  let nestedTop = 120;
  Object.defineProperties(nested, {
    scrollHeight: { configurable: true, get: () => 400 },
    clientHeight: { configurable: true, get: () => 160 },
    scrollTop: { configurable: true, get: () => nestedTop },
  });
  await act(async () => {
    nested.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -80 }));
  });
  chat.metrics.height += 100;
  await chat.resize();
  expect(chat.top).toBe(chat.end());
  // The box has nothing left above, so the wheel carries the conversation up.
  nestedTop = 0;
  await act(async () => {
    nested.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -80 }));
    chat.top = chat.end() - 120;
    chat.box.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  const reading = chat.top;
  chat.metrics.height += 250;
  await chat.resize();
  expect(chat.top).toBe(reading);
});

it('an upward key in a nested box that can still scroll up keeps the conversation following', async () => {
  sessionStorage.clear();
  const chat = await mountConversation({
    items: [
      {
        id: 'turn-0',
        content: (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a focusable scroller, as browsers make one
          <div data-testid="nested" tabIndex={0} style={{ overflowY: 'auto' }}>
            long reply
          </div>
        ),
      },
    ],
  });
  await chat.resize();
  const nested = chat.container.querySelector<HTMLElement>('[data-testid="nested"]');
  if (!nested) throw new Error('Nested box missing');
  Object.defineProperties(nested, {
    scrollHeight: { configurable: true, get: () => 400 },
    clientHeight: { configurable: true, get: () => 160 },
    scrollTop: { configurable: true, get: () => 120 },
  });
  await act(async () => {
    nested.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' }));
  });
  chat.metrics.height += 200;
  await chat.resize();
  expect(chat.top).toBe(chat.end());
});

function placedAction(label: string, top: number) {
  return (
    <button
      type="button"
      ref={(node) => {
        if (node)
          node.getBoundingClientRect = () =>
            ({ top, bottom: top + 32, left: 0, right: 80, width: 80, height: 32 }) as DOMRect;
      }}
    >
      {label}
    </button>
  );
}

it('keyboard focus on an earlier message stops following, and focus at the end does not', async () => {
  sessionStorage.clear();
  const chat = await mountConversation({
    items: [
      { id: 'turn-0', content: placedAction('Copy earlier', -300) },
      { id: 'turn-1', content: placedAction('Copy latest', 120) },
    ],
  });
  await chat.resize();
  expect(chat.top).toBe(chat.end());
  const [earlier, latest] = chat.container.querySelectorAll('button');
  await act(async () => latest?.focus());
  chat.metrics.height += 100;
  await chat.resize();
  expect(chat.top).toBe(chat.end());
  await act(async () => {
    earlier?.focus();
    chat.top = 300;
    chat.box.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  chat.metrics.height += 250;
  await chat.resize();
  expect(chat.top).toBe(300);
});

it('focus from a click does not stop following the end', async () => {
  sessionStorage.clear();
  const chat = await mountConversation({
    items: [{ id: 'turn-0', content: placedAction('Expand', -300) }],
  });
  await chat.resize();
  const button = chat.container.querySelector('button');
  await act(async () => {
    button?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    button?.focus();
    document.body.dispatchEvent(new Event('pointerup', { bubbles: true }));
  });
  chat.metrics.height += 250;
  await chat.resize();
  expect(chat.top).toBe(chat.end());
});

it('a downward key does not stop following the end', async () => {
  sessionStorage.clear();
  const chat = await mountConversation({
    items: [{ id: 'turn-0', content: <p data-testid="streamed-text">words</p> }],
  });
  await chat.resize();
  await act(async () => {
    chat.box.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
  });
  chat.metrics.height += 200;
  await chat.resize();
  expect(chat.top).toBe(chat.end());
});
