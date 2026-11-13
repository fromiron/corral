// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ChatView, placeChatRow } from './ChatView.tsx';
import { SessionConnectionContext } from './session/SessionConnection.tsx';

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
      constructor(privateCallback: (entries?: unknown) => void) {
        this.callback = privateCallback;
        resizeCallbacks.add(privateCallback);
      }
      callback: (entries?: unknown) => void;
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
      for (const callback of [...resizeCallbacks]) callback([]);
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
      for (const callback of [...resizeCallbacks]) callback([]);
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
      for (const callback of [...resizeCallbacks]) callback([]);
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
      for (const callback of [...resizeCallbacks]) callback([]);
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
  const resizeCallbacks = new Set<(entries?: unknown) => void>();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      callback: (entries?: unknown) => void;
      constructor(callback: (entries?: unknown) => void) {
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
      for (const callback of [...resizeCallbacks]) callback([]);
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
  // The virtual list sizes its window from the port's offset box, which jsdom leaves at 0 (the
  // list then keeps the window's height). Here the port is 200 high, as the tests below assume.
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

/** The composer surface of a mounted conversation, with a height the test sets. */
function composerFace(container: HTMLElement, initial: number) {
  const face = container.querySelector<HTMLElement>('[data-testid="chat-composer"]');
  if (!face) throw new Error('Composer surface missing');
  const size = { height: initial };
  face.getBoundingClientRect = () =>
    ({ top: 600 - size.height, bottom: 600, height: size.height }) as DOMRect;
  const view = container.querySelector<HTMLElement>('[data-chat-view]');
  if (!view) throw new Error('Conversation view missing');
  return { face, size, space: () => view.style.getPropertyValue('--composer-h') };
}

/** Renders a plain conversation, optionally inside the session's connection. */
async function mountPlain(
  items: { id: string; content: React.ReactNode }[],
  connection?: React.ComponentProps<typeof SessionConnectionContext.Provider>['value'],
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const view = (
    <ChatView sessionId="plain" items={items} composer={<textarea aria-label="request" />} />
  );
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        {connection === undefined ? (
          view
        ) : (
          <SessionConnectionContext.Provider value={connection}>
            {view}
          </SessionConnectionContext.Provider>
        )}
      </IntlProvider>,
    ),
  );
  return container;
}

it('the composer lies over the timeline’s bottom edge, which keeps the composer’s height as its space', async () => {
  sessionStorage.clear();
  const chat = await mountConversation({
    items: [
      { id: 'turn-0', content: <p>Earlier</p> },
      { id: 'turn-1', content: <p>Latest</p> },
    ],
  });
  const composer = composerFace(chat.container, 180);
  await chat.resize();
  // Inside the conversation view, outside the scrolling timeline, and not the window's overlay.
  expect(composer.face.closest('[data-chat-view]')).not.toBeNull();
  expect(composer.face.closest('[data-testid="chat-timeline"]')).toBeNull();
  expect(composer.face.className).toMatch(/(^|\s)absolute(\s|$)/);
  expect(composer.face.className).not.toMatch(/(^|\s)fixed(\s|$)/);
  expect(composer.space()).toBe('180px');
  // The timeline's last row ends above it, and a focused row scrolls into view above it.
  const content = chat.box.firstElementChild as HTMLElement;
  expect(content.className).toContain('pb-[calc(var(--composer-h)+0.5rem)]');
  expect(chat.box.className).toContain('scroll-pb-(--composer-h)');
});

it('while following the end, the composer growing or shrinking keeps the end in view', async () => {
  sessionStorage.clear();
  const chat = await mountConversation({ items: liveTurn(['read'], 'Working') });
  const composer = composerFace(chat.container, 160);
  await chat.resize();
  expect(chat.top).toBe(chat.end());
  // The composer grows by 100 (a queued request, a lost connection), and so does the space.
  composer.size.height = 260;
  chat.metrics.height += 100;
  await chat.resize();
  expect(composer.space()).toBe('260px');
  expect(chat.top).toBe(chat.end());
  composer.size.height = 160;
  chat.metrics.height -= 100;
  await chat.resize();
  expect(composer.space()).toBe('160px');
  expect(chat.top).toBe(chat.end());
  expect(chat.container.querySelector('[aria-label="Jump to latest"]')).toBeNull();
});

it('while reading earlier messages, the composer changing height leaves them in place', async () => {
  sessionStorage.clear();
  const chat = await mountConversation({
    items: [
      { id: 'turn-0', content: <p>Earlier</p> },
      { id: 'turn-1', content: <p>Latest</p> },
    ],
  });
  const composer = composerFace(chat.container, 160);
  await chat.resize();
  await act(async () => {
    chat.box.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -80 }));
    chat.top = 100;
    chat.box.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  for (const height of [260, 160, 300]) {
    chat.metrics.height += height - composer.size.height;
    composer.size.height = height;
    await chat.resize();
    expect(composer.space()).toBe(`${height}px`);
    expect(chat.top).toBe(100);
  }
  expect(chat.container.querySelector('[aria-label="Jump to latest"]')).not.toBeNull();
});

it('an upward wheel whose scroll already reached the top stops following the end', async () => {
  sessionStorage.clear();
  const chat = await mountConversation({
    items: [{ id: 'turn-0', content: <p data-testid="streamed-text">words</p> }],
  });
  await chat.resize();
  expect(chat.top).toBe(chat.end());
  // One wheel moves a short conversation to its top before the wheel event is handled.
  await act(async () => {
    chat.top = 0;
    chat.box.dispatchEvent(new Event('scroll', { bubbles: true }));
    chat.box.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -900 }));
  });
  chat.metrics.height += 120;
  await chat.resize();
  expect(chat.top).toBe(0);
  expect(chat.container.querySelector('[aria-label="Jump to latest"]')).not.toBeNull();
});

it('virtualizes the timeline the same way for three rows as for two hundred', async () => {
  sessionStorage.clear();
  const rows = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `turn-${index}`,
      content: <p>Turn {index}</p>,
    }));
  const chat = await mountConversation({ items: rows(3) });
  await chat.resize();
  /** The list's structure, without the offsets that depend on where each row is. */
  const layout = () => {
    const list = chat.container.querySelector<HTMLElement>('[data-testid="chat-timeline"] ol');
    if (!list) throw new Error('Conversation list missing');
    const mounted = [...list.children] as HTMLElement[];
    return {
      window: list.hasAttribute('data-chat-window'),
      // What the window holds for the rows it does not mount (jsdom rows count as estimated).
      held: Number.parseFloat(list.style.paddingTop) + Number.parseFloat(list.style.paddingBottom),
      mounted,
      rows: new Set(
        mounted.map((row) =>
          [
            row.classList.contains('flow-root'),
            row.getAttribute('aria-setsize'),
            row.getAttribute('aria-posinset') !== null,
            row.hasAttribute('data-chat-item'),
            row.hasAttribute('data-index'),
          ].join(' '),
        ),
      ),
    };
  };
  const few = layout();
  // Even three rows take the windowed path, with nothing held back.
  expect(few.window).toBe(true);
  expect(few.held).toBe(0);
  expect(few.mounted).toHaveLength(3);
  expect([...few.rows]).toEqual(['true 3 true true true']);
  expect(few.mounted.map((row) => row.getAttribute('aria-posinset'))).toEqual(['1', '2', '3']);
  for (const count of [40, 41, 60, 200]) {
    await chat.update({ items: rows(count) });
    await chat.resize();
    const many = layout();
    expect(many.window).toBe(true);
    expect([...many.rows]).toEqual([`true ${count} true true true`]);
    // Only the rows in and near the view are mounted; the rest are held as space.
    expect(many.mounted.length).toBeLessThan(Math.min(count, 20));
    expect(many.held).toBe((count - many.mounted.length) * 260);
  }
});

/**
 * A long conversation of rows at the list's estimated height, laid out as the browser would:
 * each mounted row sits at its index's place below the content's top padding.
 */
async function mountLong(count: number, content?: (index: number) => React.ReactNode) {
  const chat = await mountConversation({
    items: Array.from({ length: count }, (_, index) => ({
      id: `turn-${index}`,
      content: content ? content(index) : <p>Turn {index}</p>,
    })),
  });
  chat.metrics.height = 24 + count * 260 + 8;
  // A row that grew: every row after it sits that much lower.
  const grown = { index: count, by: 0 };
  const rect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.tagName !== 'LI' || !this.hasAttribute('data-chat-item')) return rect.call(this);
    const index = Number(this.dataset.index);
    const top = 24 + index * 260 + (index > grown.index ? grown.by : 0) - chat.top;
    return { top, bottom: top + 260, height: 260, left: 0, right: 480, width: 480 } as DOMRect;
  });
  disposals.push(async () => {
    vi.restoreAllMocks();
  });
  await chat.resize();
  const scroll = (top: number) =>
    act(async () => {
      chat.top = top;
      chat.box.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
  /** What the list holds for the rows it does not mount, padding and the space between rows. */
  const held = () => {
    const list = chat.container.querySelector<HTMLElement>('[data-chat-window]');
    if (!list) throw new Error('Conversation list missing');
    const rows = [...list.children] as HTMLElement[];
    return {
      mounted: rows.map((row) => Number(row.dataset.index)),
      space:
        Number.parseFloat(list.style.paddingTop || '0') +
        Number.parseFloat(list.style.paddingBottom || '0') +
        rows.reduce((sum, row) => sum + Number.parseFloat(row.style.marginTop || '0'), 0),
    };
  };
  /** Presses a key on `target`; says whether the view kept the browser from acting on it. */
  const key = async (target: Element, key: string, modifiers: KeyboardEventInit = {}) => {
    let prevented = false;
    await act(async () => {
      prevented = !target.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...modifiers }),
      );
    });
    return prevented;
  };
  /** Row `index` grows by `by` more: every row after it sits that much lower. */
  const grow = (index: number, by: number) => {
    if (grown.by !== 0 && grown.index !== index) throw new Error('One row grows per fixture');
    grown.index = index;
    grown.by += by;
    chat.metrics.height += by;
  };
  // Assigned onto the fixture, so its scroll position stays a live getter.
  return Object.assign(chat, { scroll, held, key, grow });
}

it('a focused row kept mounted away from the window holds the rows between them as space', async () => {
  sessionStorage.clear();
  const chat = await mountLong(200, (index) => <button type="button">Copy {index}</button>);
  await chat.scroll(chat.end());
  const last = chat.container.querySelector<HTMLButtonElement>(
    '[data-chat-item="turn-199"] button',
  );
  if (!last) throw new Error('Last row missing');
  await act(async () => last.focus());
  // The person reads far above the focused row.
  await act(async () => {
    chat.box.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -900 }));
  });
  await chat.scroll(20_000);
  const { mounted, space } = chat.held();
  // The focused row stays mounted (and focused), apart from the rows in view.
  expect(mounted).toContain(199);
  expect(mounted).toContain(Math.floor(20_000 / 260));
  expect(document.activeElement).toBe(last);
  // Every row the list does not mount is still held as space, so the list keeps its height.
  expect(space).toBe((200 - mounted.length) * 260);
  // And the other way: the focus far above, the person back at the end.
  const reading = chat.container.querySelector<HTMLButtonElement>(
    '[data-chat-item="turn-77"] button',
  );
  if (!reading) throw new Error('Reading row missing');
  await act(async () => reading.focus());
  await chat.scroll(chat.end());
  const back = chat.held();
  expect(back.mounted).toContain(77);
  expect(back.mounted).toContain(199);
  expect(back.space).toBe((200 - back.mounted.length) * 260);
  // The space held above a kept row is not part of that row's size: measured with it, the
  // row would carry it into the history once it leaves the window.
  const mountedRows = [...chat.container.querySelectorAll('[data-chat-item]')];
  await act(async () => {
    for (const callback of [...resizeCallbacks])
      callback(mountedRows.map((target) => ({ target })));
  });
  await act(async () => reading.blur());
  const left = chat.held();
  expect(left.mounted).not.toContain(77);
  expect(left.space).toBe((200 - left.mounted.length) * 260);
});

it('a row above the reader changing size is left to the browser, not corrected by the list', async () => {
  sessionStorage.clear();
  const chat = await mountLong(200);
  await act(async () => {
    chat.box.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -900 }));
  });
  // Reading, last moving down: a list that corrects would shift by a row above changing size.
  await chat.scroll(4_900);
  await chat.scroll(5_000);
  const row = chat.container.querySelector<HTMLElement>('[data-chat-item="turn-16"]');
  if (!row) throw new Error('Row above the view missing');
  // The row grows by 140 entirely above the view. The browser's scroll anchoring holds the
  // rows in view; the list writing its own correction as well would move them twice.
  row.getBoundingClientRect = () =>
    ({ top: -700, bottom: -300, height: 400, left: 0, right: 480, width: 480 }) as DOMRect;
  await act(async () => {
    for (const callback of [...resizeCallbacks]) callback([{ target: row }]);
  });
  expect(chat.top).toBe(5_000);
});

it('a mounted row’s new height reaches the list in the change that made it, before its resize is observed', async () => {
  sessionStorage.clear();
  const chat = await mountLong(200);
  await act(async () => {
    chat.box.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -900 }));
  });
  await chat.scroll(5_000);
  const row = chat.container.querySelector<HTMLElement>('[data-chat-item="turn-16"]');
  if (!row) throw new Error('Row above the view missing');
  // The row's content grows by 140 (a run's record loaded); no resize observer has run yet.
  row.getBoundingClientRect = () =>
    ({ top: -700, bottom: -300, height: 400, left: 0, right: 480, width: 480 }) as DOMRect;
  await act(async () => {
    row.firstElementChild?.setAttribute('class', 'loaded');
  });
  // Read far below, the row leaves the window: the space held for it is its new height.
  await chat.scroll(30_000);
  const { mounted, space } = chat.held();
  expect(mounted).not.toContain(16);
  expect(space).toBe((200 - mounted.length) * 260 + 140);
});

it('a scroll that moved on since the reader’s place was read is not pulled back to it', async () => {
  sessionStorage.clear();
  const chat = await mountLong(60);
  expect(chat.top).toBe(chat.end());
  // A key scroll animates over frames. Its first frame's scroll event is read before the list
  // mounts the rows now in view; the place is read once they are.
  await chat.key(chat.box, 'PageUp');
  await chat.scroll(15_132);
  // A row above the reader grows: the reader's row holds its place on screen.
  chat.grow(50, 100);
  await chat.resize();
  expect(chat.top).toBe(15_232);
  await chat.scroll(15_232);
  // The next frame moves the view again, and the list mounts rows for it before that frame's
  // scroll event is handled: placing the view then keeps where the person is going.
  chat.top = 14_932;
  await chat.resize();
  expect(chat.top).toBe(14_932);
  await chat.scroll(14_632);
  expect(chat.top).toBe(14_632);
  // Nothing moved since the place was read, so placing the view writes nothing.
  let writes = 0;
  const read = () => chat.top;
  Object.defineProperty(chat.box, 'scrollTop', {
    configurable: true,
    get: read,
    set: (value: number) => {
      writes += 1;
      chat.top = value;
    },
  });
  await chat.resize();
  expect(writes).toBe(0);
  // Less than half a pixel is not drawn: the view writes nothing for it. A whole pixel more is.
  chat.grow(50, 0.3);
  await chat.resize();
  expect(writes).toBe(0);
  expect(chat.top).toBe(14_632);
  chat.grow(50, 0.7);
  await chat.resize();
  expect(writes).toBe(1);
  expect(chat.top).toBe(14_633);
  // However little the view moved since the place was read, it is not pulled back.
  chat.top = 14_630;
  await chat.resize();
  expect(chat.top).toBe(14_630);
  expect(chat.container.querySelector('[aria-label="Jump to latest"]')).not.toBeNull();
});

it('a history cut short above the reader puts the reader’s row back, rather than following the end', async () => {
  sessionStorage.clear();
  const chat = await mountLong(60);
  await act(async () => {
    chat.box.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -900 }));
  });
  await chat.scroll(15_000);
  await chat.scroll(15_000);
  // A row above the reader comes back shorter than the list held for it, in a change that also
  // moves the list's padding, so the browser does not anchor: the history is 900 shorter and
  // the offset is cut at its new end.
  chat.grow(50, -900);
  chat.top = chat.end();
  await chat.resize();
  expect(chat.top).toBe(14_100);
  await act(async () => {
    chat.box.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  chat.metrics.height += 300;
  await chat.resize();
  expect(chat.top).toBe(14_100);
  expect(chat.container.querySelector('[aria-label="Jump to latest"]')).not.toBeNull();
});

for (const count of [30, 300]) {
  it(`Home and End on the timeline reach the first row and the end (${count} rows)`, async () => {
    sessionStorage.clear();
    const chat = await mountLong(count);
    expect(chat.top).toBe(chat.end());
    // The view moves itself; the browser's own scroll for the key does not run as well.
    expect(await chat.key(chat.box, 'Home')).toBe(true);
    expect(chat.top).toBe(0);
    // Left the end in the same task, before the scroll's event.
    expect(chat.container.querySelector('[aria-label="Jump to latest"]')).not.toBeNull();
    await chat.scroll(0);
    expect(chat.held().mounted[0]).toBe(0);
    // Rows mounting at the top do not move the reader off the first row.
    await chat.resize();
    expect(chat.top).toBe(0);
    expect(await chat.key(chat.box, 'End')).toBe(true);
    expect(chat.top).toBe(chat.end());
    // At the end, End follows it: the end growing stays in view.
    chat.metrics.height += 400;
    await chat.resize();
    expect(chat.top).toBe(chat.end());
    expect(chat.container.querySelector('[aria-label="Jump to latest"]')).toBeNull();
  });
}

it('Home and End from a control inside a row are that control’s keys', async () => {
  sessionStorage.clear();
  const chat = await mountLong(30, (index) => <button type="button">Copy {index}</button>);
  await chat.scroll(chat.end());
  const button = chat.container.querySelector<HTMLButtonElement>(
    '[data-chat-item="turn-29"] button',
  );
  if (!button) throw new Error('Row action missing');
  const at = chat.top;
  expect(await chat.key(button, 'Home')).toBe(false);
  expect(chat.top).toBe(at);
  // Focused, the control's row stays mounted while the person reads far above it.
  await act(async () => button.focus());
  await act(async () => {
    chat.box.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -900 }));
  });
  await chat.scroll(1_000);
  expect(button.isConnected).toBe(true);
  expect(await chat.key(button, 'End')).toBe(false);
  expect(chat.top).toBe(1_000);
  expect(chat.container.querySelector('[aria-label="Jump to latest"]')).not.toBeNull();
});

it('Ctrl or Cmd with Home and End go to the first row and the end; Shift and Alt are the browser’s', async () => {
  sessionStorage.clear();
  const chat = await mountLong(30);
  for (const modifiers of [{ shiftKey: true }, { altKey: true }]) {
    expect(await chat.key(chat.box, 'Home', modifiers)).toBe(false);
    expect(chat.top).toBe(chat.end());
  }
  expect(await chat.key(chat.box, 'Home', { ctrlKey: true })).toBe(true);
  expect(chat.top).toBe(0);
  for (const modifiers of [{ shiftKey: true }, { altKey: true }]) {
    expect(await chat.key(chat.box, 'End', modifiers)).toBe(false);
    expect(chat.top).toBe(0);
  }
  expect(await chat.key(chat.box, 'End', { metaKey: true })).toBe(true);
  expect(chat.top).toBe(chat.end());
  await chat.key(chat.box, 'Home', { metaKey: true });
  expect(chat.top).toBe(0);
  await chat.key(chat.box, 'End', { ctrlKey: true });
  expect(chat.top).toBe(chat.end());
});

it('a restored row is held against a move down until the person moves up', async () => {
  sessionStorage.clear();
  sessionStorage.setItem(
    'corral:chat-scroll:session-follow',
    JSON.stringify({ top: 5_000, follow: false, anchor: { id: 'turn-30', offset: 0 } }),
  );
  const chat = await mountLong(60);
  // The list goes to the row first, then the row is placed once it is mounted.
  await chat.scroll(chat.top);
  await chat.resize();
  const held = 24 + 30 * 260;
  expect(chat.top).toBe(held);
  // A downward key: the browser's scroll is put back, and every placing writes the offset,
  // which stops the key's animation instead of letting it run on a frame at a time.
  let writes = 0;
  Object.defineProperty(chat.box, 'scrollTop', {
    configurable: true,
    get: () => chat.top,
    set: (value: number) => {
      writes += 1;
      chat.top = value;
    },
  });
  await chat.key(chat.box, 'PageDown');
  chat.top = held + 200;
  await chat.resize();
  expect(chat.top).toBe(held);
  writes = 0;
  await chat.resize();
  expect(writes).toBeGreaterThan(0);
  expect(chat.top).toBe(held);
  // Moving up ends the hold.
  await chat.key(chat.box, 'PageUp');
  await chat.scroll(held - 300);
  await chat.resize();
  expect(chat.top).toBe(held - 300);
});

it('a row placed at an offset by its link is held there, above the top, until the person moves up', async () => {
  sessionStorage.clear();
  const chat = await mountLong(60);
  // A passage deep in a tall row: the row starts above the view.
  await act(async () => placeChatRow('session-follow', 'turn-30', -150));
  await chat.scroll(chat.top);
  await chat.resize();
  const held = 24 + 30 * 260 + 150;
  expect(chat.top).toBe(held);
  await chat.key(chat.box, 'PageDown');
  chat.top = held + 200;
  await chat.resize();
  expect(chat.top).toBe(held);
  // Another session's placing is not this one's.
  await act(async () => placeChatRow('elsewhere', 'turn-10', 0));
  await chat.resize();
  expect(chat.top).toBe(held);
});

it('a restored offset waits for the history to be tall enough, without reading a place first', async () => {
  sessionStorage.clear();
  sessionStorage.setItem(
    'corral:chat-scroll:session-follow',
    JSON.stringify({ top: 5_000, follow: false }),
  );
  // Mounted while the history is still 800 high; then it reaches its full height.
  const chat = await mountLong(60);
  expect(chat.top).toBe(5_000);
  expect(chat.container.querySelector('[aria-label="Jump to latest"]')).not.toBeNull();
});

it('marks every timeline row with its item’s identity', async () => {
  const items = [
    { id: 'entry-user', content: <p>A request</p> },
    { id: 'run-1', content: <section>A run</section> },
    { id: 'notice-2', content: <div>Something else</div> },
  ];
  const container = await mountPlain(items);
  const rows = [...container.querySelectorAll('[data-testid="chat-timeline"] ol > li')];
  expect(rows.map((row) => row.getAttribute('data-chat-item'))).toEqual(
    items.map((item) => item.id),
  );
  // What the scene probe reads: the timeline, and the composer surface around the input.
  expect(container.querySelector('[data-testid="chat-timeline"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="chat-composer"] textarea')).not.toBeNull();
});

it('a lost connection is said at the top of the composer, never above or inside the timeline', async () => {
  const retry = vi.fn();
  const container = await mountPlain([{ id: 'entry', content: <p>reply</p> }], {
    lost: true,
    retry,
  });
  const alert = container.querySelector<HTMLElement>('[role="alert"]');
  const timeline = container.querySelector('[data-testid="chat-timeline"]');
  const composer = container.querySelector('[data-testid="chat-composer"]');
  const input = container.querySelector('textarea');
  if (!alert || !timeline || !composer || !input) throw new Error('Conversation fixture missing');
  expect(alert.textContent).toContain(messages.Sessions.connectionLost);
  expect(composer.contains(alert)).toBe(true);
  expect(timeline.contains(alert)).toBe(false);
  // After the timeline, first in the composer: where the activity bar will say it.
  expect(timeline.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(alert.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await act(async () => {
    alert.querySelector('button')?.click();
  });
  expect(retry).toHaveBeenCalledOnce();
});

it('says nothing about the connection while it holds', async () => {
  const container = await mountPlain([{ id: 'entry', content: <p>reply</p> }], {
    lost: false,
    retry: () => {},
  });
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('a change inside the composer alone places the end again, without any resize', async () => {
  sessionStorage.clear();
  const chat = await mountConversation({ items: liveTurn(['read'], 'Working') });
  const composer = composerFace(chat.container, 160);
  await chat.resize();
  expect(chat.top).toBe(chat.end());
  // A line appears in the composer: its subtree changes and it is 60px taller, and the
  // timeline's bottom space grows with it. No observer of the timeline is told.
  composer.size.height = 220;
  chat.metrics.height += 60;
  await act(async () => {
    composer.face.querySelector('textarea')?.setAttribute('rows', '3');
  });
  expect(composer.space()).toBe('220px');
  expect(chat.top).toBe(chat.end());
});

it('an upward wheel that reached the top keeps the reader’s row when content above it grows', async () => {
  sessionStorage.clear();
  const chat = await mountConversation({
    items: [{ id: 'turn-0', content: <p>words</p> }],
  });
  const row = chat.container.querySelector<HTMLElement>('[data-chat-item="turn-0"]');
  if (!row) throw new Error('Conversation row missing');
  let above = 0;
  row.getBoundingClientRect = () =>
    ({ top: above - chat.top, bottom: above - chat.top + 500, height: 500 }) as DOMRect;
  await chat.resize();
  await act(async () => {
    chat.top = 0;
    chat.box.dispatchEvent(new Event('scroll', { bubbles: true }));
    chat.box.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -900 }));
  });
  // Something above the row grows by 50: the reader's row stays where it was on screen.
  above = 50;
  chat.metrics.height += 50;
  await chat.resize();
  expect(chat.top).toBe(50);
});

it('the composer leaves the timeline’s scrollbar uncovered', async () => {
  sessionStorage.clear();
  const chat = await mountConversation({
    items: [{ id: 'turn-0', content: <p>words</p> }],
  });
  // The timeline is 480 wide (mountConversation) with 15 of it taken by its scrollbar.
  Object.defineProperty(chat.box, 'clientWidth', { configurable: true, get: () => 465 });
  const composer = composerFace(chat.container, 160);
  composer.size.height = 170;
  await chat.resize();
  const view = chat.container.querySelector<HTMLElement>('[data-chat-view]');
  expect(view?.style.getPropertyValue('--timeline-gutter')).toBe('15px');
  expect(composer.face.className).toContain('right-(--timeline-gutter)');
});

it('the composer zone is the page floor with a fade above it, not a raised surface', async () => {
  sessionStorage.clear();
  const chat = await mountConversation({
    items: [{ id: 'turn-0', content: <p>words</p> }],
  });
  const face = chat.container.querySelector<HTMLElement>('[data-testid="chat-composer"]');
  if (!face) throw new Error('Composer surface missing');
  expect(face.className).toContain('bg-(--chat-floor)');
  expect(face.className).not.toMatch(/shadow|ring|border|bg-surface/);
  const fade = face.querySelector<HTMLElement>('[data-composer-fade]');
  expect(fade?.getAttribute('aria-hidden')).toBe('true');
  // Painted above the zone, out of its layout, and never in the pointer's way.
  expect(fade?.className).toMatch(/(^|\s)absolute(\s|$)/);
  expect(fade?.className).toContain('bottom-full');
  expect(fade?.className).toContain('pointer-events-none');
  expect(fade?.className).toContain('to-(--chat-floor)');
});

it('moving from the empty session to the conversation keeps the same composer, draft and focus', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  // The composer's own state (its attachments, say) lives as long as it stays mounted.
  let mounts = 0;
  function Composer() {
    useEffect(() => {
      mounts += 1;
    }, []);
    return <textarea aria-label="request" defaultValue="" />;
  }
  const draw = (items: { id: string; content: React.ReactNode }[]) =>
    act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <ChatView centerEmpty sessionId="home" items={items} composer={<Composer />} />
        </IntlProvider>,
      ),
    );
  await draw([]);
  const face = container.querySelector('[data-testid="chat-composer"]');
  const input = container.querySelector('textarea');
  if (!face || !input) throw new Error('Composer missing');
  expect(face.getAttribute('data-composer-surface')).toBe('inline');
  expect(face.querySelector('[data-composer-fade]')).toBeNull();
  input.value = 'A draft with a selection';
  input.focus();
  input.setSelectionRange(2, 7);
  await draw([{ id: 'first', content: <p>First request</p> }]);
  expect(container.querySelector('[data-testid="chat-composer"]')).toBe(face);
  expect(face.getAttribute('data-composer-surface')).toBe('floating');
  expect(container.querySelector('textarea')).toBe(input);
  expect(input.value).toBe('A draft with a selection');
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
  expect(mounts).toBe(1);
});
