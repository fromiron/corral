// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { ChatView } from './ChatView.tsx';

const resizeCallbacks = new Set<() => void>();
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

async function render(aside?: React.ReactNode, expandedHeader = false, messageId?: string) {
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
          items={[{ id: 'entry', content: <p>reply</p> }]}
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

it('the widgets sit in the right margin and hide when it is too narrow', () => {
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
  // Below it the composer's button opens the same widgets.
  expect(css).toMatch(
    /@container chat-view \(max-width: 74\.99rem\)\s*\{\s*\.session-widget-access\s*\{\s*display:\s*flex;/,
  );
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
    box.dispatchEvent(new Event('wheel', { bubbles: true }));
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

it('expanded records use the reading area while retaining the composer and mounted conversation', async () => {
  const container = await render(undefined, true);
  const timeline = container.querySelector<HTMLElement>('[data-testid="chat-timeline"]');
  expect(timeline?.hidden).toBe(true);
  expect(timeline?.textContent).toContain('reply');
  expect(container.querySelector('textarea[aria-label="request"]')?.closest('[hidden]')).toBeNull();
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
