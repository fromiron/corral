// @vitest-environment jsdom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { SAMPLE_TASKS } from '../feature-preview/fixture.ts';
import { previewStore, resetPreviews } from '../feature-preview/store.ts';
import { ServicesProvider, type StudioServices } from '../services.tsx';
import {
  PREVIEW_FEATURES,
  PreviewPage,
  previewFeature,
  validatePreviewSearch,
} from './PreviewPage.tsx';

// Feature previews (docs/specs/features/feature-preview.md): sample flows that keep the sample
// banner, mark every result "Simulated", reset to the fixture and never reach the server.

Element.prototype.getAnimations ??= () => [];
Element.prototype.scrollIntoView ??= () => {};

/** Every read of the app services is a failure: previews must not use them at all. */
const serviceReads: string[] = [];
const services = new Proxy({} as StudioServices, {
  get(_target, key) {
    serviceReads.push(String(key));
    throw new Error(`a preview read services.${String(key)}`);
  },
});
const network = {
  fetch: vi.fn(async () => {
    throw new Error('a preview called fetch');
  }),
  socket: vi.fn(),
  xhr: vi.fn(),
  events: vi.fn(),
};

const disposals: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', network.fetch);
  vi.stubGlobal('WebSocket', network.socket);
  vi.stubGlobal('XMLHttpRequest', network.xhr);
  vi.stubGlobal('EventSource', network.events);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  serviceReads.length = 0;
  for (const spy of Object.values(network)) spy.mockClear();
  resetPreviews();
});
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 4; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

async function render(url: string) {
  const root = createRootRoute({ component: () => <Outlet /> });
  const hub = createRoute({
    getParentRoute: () => root,
    path: '/preview',
    validateSearch: validatePreviewSearch,
    component: () => <PreviewPage />,
  });
  const feature = createRoute({
    getParentRoute: () => root,
    path: '/preview/$feature',
    validateSearch: validatePreviewSearch,
    component: function Feature() {
      return <PreviewPage feature={feature.useParams().feature} />;
    },
  });
  const session = createRoute({
    getParentRoute: () => root,
    path: '/sessions/$sessionId',
    component: () => <p data-testid="elsewhere">session</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([hub, feature, session]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const container = document.createElement('div');
  document.body.append(container);
  const reactRoot = createRoot(container);
  disposals.push(async () => {
    await act(async () => reactRoot.unmount());
    container.remove();
  });
  await act(async () => {
    reactRoot.render(
      <ServicesProvider services={services}>
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <RouterProvider router={router} />
        </IntlProvider>
      </ServicesProvider>,
    );
    await router.load();
  });
  await settle();
  return { container, router };
}

const all = (container: HTMLElement, selector: string) => [
  ...container.querySelectorAll<HTMLElement>(selector),
];
const byText = (container: HTMLElement, selector: string, text: string | RegExp) =>
  all(container, selector).find((element) =>
    typeof text === 'string'
      ? element.textContent?.trim() === text
      : text.test(element.textContent ?? ''),
  );
const button = (container: HTMLElement, name: string | RegExp) => {
  const found = all(container, 'button, a').find((element) => {
    const label = element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '';
    return typeof name === 'string' ? label === name : name.test(label);
  });
  if (!found) throw new Error(`no control named ${String(name)}`);
  return found;
};
async function click(element: HTMLElement) {
  await act(async () => element.click());
  await settle();
}
async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}
const banner = (container: HTMLElement) =>
  byText(container, '[role="note"]', /Preview · sample data/);
const simulated = (container: HTMLElement) =>
  all(container, '*').filter(
    (element) =>
      element.children.length === 0 && /Simulated|simulated/.test(element.textContent ?? ''),
  );
function expectNoRequests() {
  expect(serviceReads).toEqual([]);
  expect(network.fetch).not.toHaveBeenCalled();
  expect(network.socket).not.toHaveBeenCalled();
  expect(network.xhr).not.toHaveBeenCalled();
  expect(network.events).not.toHaveBeenCalled();
}

it('knows only the three sample flows', () => {
  expect(PREVIEW_FEATURES).toEqual(['task-board', 'pr-review', 'browser-qa']);
  for (const feature of PREVIEW_FEATURES) expect(previewFeature(feature)).toBe(feature);
  for (const other of ['', 'Task-Board', 'task-board ', 'settings', 'toString', undefined, 1])
    expect(previewFeature(other)).toBeUndefined();
});

it('keeps only an in-app return address', () => {
  expect(validatePreviewSearch({ returnTo: '/projects/project_a' })).toEqual({
    returnTo: '/projects/project_a',
  });
  for (const returnTo of ['https://example.org', '//example.org', '/settings', 'projects'])
    expect(validatePreviewSearch({ returnTo })).toEqual({});
});

it('lists every preview with an Open link under the sample banner, also for an unknown feature', async () => {
  for (const url of ['/preview', '/preview/unknown', '/preview/toString']) {
    const { container } = await render(url);
    expect(container.querySelector('h1')?.textContent).toBe('Feature previews');
    expect(container.querySelector('main')?.dataset.previewFeature).toBeUndefined();
    expect(banner(container)).toBeDefined();
    const links = PREVIEW_FEATURES.map((feature) =>
      container.querySelector<HTMLAnchorElement>(`a[href="/preview/${feature}"]`),
    );
    expect(links.every((link) => link?.textContent === 'Open')).toBe(true);
  }
  expectNoRequests();
});

it('goes back to an in-app return address, and offers no way back to an external one', async () => {
  const { container, router } = await render('/preview?returnTo=%2Fsessions%2Fsession_a');
  const open = container.querySelector<HTMLAnchorElement>('a[href^="/preview/task-board"]');
  expect(open?.getAttribute('href')).toBe('/preview/task-board?returnTo=%2Fsessions%2Fsession_a');
  await click(button(container, 'Back'));
  expect(router.state.location.href).toBe('/sessions/session_a');

  for (const returnTo of ['https://example.org', '//example.org/sessions/x']) {
    const outside = await render(`/preview/task-board?returnTo=${encodeURIComponent(returnTo)}`);
    expect(() => button(outside.container, 'Back')).toThrow();
    expect(outside.container.querySelector(`a[href*="example.org"]`)).toBeNull();
  }
});

it('changes a task status as a simulation, with no request, and resets to the fixture', async () => {
  const { container } = await render('/preview/task-board');
  expect(container.querySelector('main')?.dataset.previewFeature).toBe('task-board');
  expect(banner(container)).toBeDefined();
  expect(simulated(container)).toEqual([]);
  const task = SAMPLE_TASKS.find((item) => item.id === previewStore.getState().board.selected);
  if (!task) throw new Error('no task is open in the detail');
  expect(task.status).not.toBe('merged');

  const status = all(container, 'fieldset').find(
    (group) => group.querySelector('legend')?.textContent === 'Status',
  );
  if (!status) throw new Error('no status control');
  await click(button(status, 'Done'));
  expect(previewStore.getState().board.statuses[task.id]).toBe('merged');
  expect(button(status, 'Done').getAttribute('aria-pressed')).toBe('true');
  expect(simulated(container).length).toBeGreaterThan(0);
  expect(banner(container)).toBeDefined();
  expectNoRequests();

  await click(button(container, 'Reset'));
  expect(previewStore.getState().board.statuses[task.id]).toBe(task.status);
  expect(simulated(container)).toEqual([]);
  expect(banner(container)).toBeDefined();
});

it('posts a comment and requests fixes on a pull request as a simulation, with no request', async () => {
  const { container } = await render('/preview/pr-review');
  expect(banner(container)).toBeDefined();

  await click(button(container, /^Comments/));
  const field = container.querySelector<HTMLTextAreaElement>('textarea');
  if (!field) throw new Error('no comment field');
  await type(field, 'Keep the rounding rule in one place.');
  await click(button(container, 'Post comment'));
  const comment = byText(container, 'li', /Keep the rounding rule in one place\./);
  expect(comment?.textContent).toMatch(/Simulated/);

  await click(button(container, /^Changes/));
  await click(button(container, 'Request fixes'));
  const feedback =
    container.querySelector<HTMLInputElement>('input[aria-label="What should change"]') ??
    container.querySelector<HTMLInputElement>('form input');
  if (!feedback) throw new Error('no fix request field');
  await type(feedback, 'Round half-cents up.');
  await act(async () => feedback.form?.requestSubmit());
  await settle();
  const selected = previewStore.getState().review.selected;
  expect(previewStore.getState().review.answers[selected]).toEqual({
    kind: 'fixes',
    feedback: 'Round half-cents up.',
  });
  const card = container.querySelector<HTMLElement>(`[data-pull="${selected}"]`);
  expect(card?.textContent).toMatch(/Fixes requested.*Simulated/);
  expect(banner(container)).toBeDefined();
  expectNoRequests();
});

it('walks the browser QA steps by keyboard and attaches the screenshot only inside the preview', async () => {
  const { container } = await render('/preview/browser-qa');
  expect(banner(container)).toBeDefined();
  const steps = container.querySelector<HTMLElement>('[role="tablist"]');
  if (!steps) throw new Error('no step list');

  const snapshotTab = byText(steps, '[role="tab"]', /Snapshot/);
  expect(
    snapshotTab?.hasAttribute('disabled') || snapshotTab?.getAttribute('aria-disabled'),
  ).toBeTruthy();
  await click(button(container, 'Open page'));
  expect(simulated(container).length).toBeGreaterThan(0);
  await click(button(container, 'Next: Snapshot'));
  expect(snapshotTab?.getAttribute('aria-selected')).toBe('true');
  // Arrow keys move between the steps already reached.
  const openTab = byText(steps, '[role="tab"]', /Open/);
  await act(async () => {
    snapshotTab?.focus();
    snapshotTab?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  });
  await settle();
  expect(document.activeElement).toBe(openTab);

  await click(snapshotTab as HTMLElement);
  for (const [action, next] of [
    ['Take snapshot', 'Next: Act'],
    ['Run actions', 'Next: Console'],
    ['Read console', 'Next: Screenshot'],
  ]) {
    await click(button(container, action as string));
    await click(button(container, next as string));
  }
  expect(byText(container, 'td', /TypeError/)).toBeUndefined();
  await click(button(container, 'Take screenshot'));
  expect(container.querySelector('svg[role="img"]')).not.toBeNull();
  expect(container.querySelector('img')).toBeNull();
  await click(byText(steps, '[role="tab"]', /Console/) as HTMLElement);
  expect(byText(container, 'td', /TypeError/)).toBeDefined();
  await click(byText(steps, '[role="tab"]', /Screenshot/) as HTMLElement);
  await click(button(container, 'Next: Attach'));
  await click(button(container, 'Attach to conversation'));
  expect(byText(container, '*', 'Attached (simulated)')).toBeDefined();
  expect(previewStore.getState().browser.progress).toBe(6);
  expect(banner(container)).toBeDefined();
  expectNoRequests();
});
