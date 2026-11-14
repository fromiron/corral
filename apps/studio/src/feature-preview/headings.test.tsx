// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeAll, expect, it } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { BrowserQaPreview } from './BrowserQaPreview.tsx';
import { SAMPLE_PULLS } from './fixture.ts';
import { PullReviewPreview } from './PullReviewPreview.tsx';
import { resetPreviews } from './store.ts';

// A preview heading keeps what the row above it does not already say: the pull request detail
// leaves its branch to the list row, the diff under the Changes tab names its files only to
// assistive technology, and the page address reads as the address itself.

const cleanups: (() => void)[] = [];
beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Element.prototype.getAnimations ??= () => [];
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetPreviews();
});

async function render(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        {node}
      </IntlProvider>,
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

const visibleText = (element: Element) => {
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('.sr-only')) hidden.remove();
  return copy.textContent ?? '';
};

it('leaves the branch to the pull request row', async () => {
  const container = await render(<PullReviewPreview />);
  const pull = SAMPLE_PULLS[0];
  const header = container.querySelector('section header');
  expect(header).toBeTruthy();
  expect(header?.textContent).not.toContain(pull?.branch);
});

it('names the reviewed files only to assistive technology under the Changes tab', async () => {
  const container = await render(<PullReviewPreview />);
  const pull = SAMPLE_PULLS[0];
  const review = 'Review changes to';
  const panel = container.querySelector('[role="tabpanel"]');
  expect(panel?.textContent).toContain(review);
  expect(visibleText(panel as Element)).not.toContain(review);
  expect(pull?.files.length).toBeGreaterThan(0);
});

it('keeps Page address as the accessible name of the address only', async () => {
  const container = await render(<BrowserQaPreview />);
  const address = messages.FeaturePreview.browser.address;
  expect(container.textContent).toContain(address);
  expect(visibleText(container)).not.toContain(address);
});
