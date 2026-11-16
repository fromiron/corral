// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { DockPaneSwitcher } from './DockTopBar.tsx';

const disposals: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  Element.prototype.getAnimations ??= () => [];
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

/** Text a person reads: the kit draws each label twice, once hidden to reserve its bold width. */
function visibleText(element: Element | null | undefined) {
  const copy = element?.cloneNode(true) as Element | undefined;
  for (const hidden of copy?.querySelectorAll('[aria-hidden="true"]') ?? []) hidden.remove();
  return copy?.textContent?.trim();
}

it('a narrow pane switcher reads Panes, not the open file its tab already names', async () => {
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
        <DockPaneSwitcher
          panels={[{ id: 'document:readme', title: 'README.md' }]}
          onSelectPane={() => {}}
        />
      </IntlProvider>,
    ),
  );
  const toolbar = container.querySelector('[data-testid="dock-toolbar"]');
  const switcher = toolbar?.querySelector<HTMLElement>('[role="combobox"]');
  expect(switcher?.getAttribute('aria-label')).toBe(messages.Docking.panes);
  expect(visibleText(switcher)).toBe(messages.Docking.panes);
});
