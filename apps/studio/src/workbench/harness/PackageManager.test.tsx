// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { PackageManager } from './PackageManager.tsx';

const navigation = vi.hoisted(() => ({ item: undefined as string | undefined }));
const lifecycle = vi.hoisted(() => ({ leave: true }));
vi.mock('@tanstack/react-router', () => ({ Link: () => null }));
vi.mock('../navigation.ts', () => ({
  useSettingsNavigation: () => ({ item: navigation.item, link: () => ({ to: '/' }) }),
}));
vi.mock('../SettingsLifecycle.tsx', () => ({
  useSettingsCommand: () => ({ current: null }),
  useSettingsForm: () => async () => lifecycle.leave,
  useSettingsTask: () => (action: () => Promise<unknown>) => action(),
}));
vi.mock('./ConfirmAction.tsx', () => ({
  useManagementConfirmation: () => ({
    request: (_message: string, action: () => void) => action(),
    dialog: null,
  }),
}));

const view = (
  name: string,
  hash: string,
  is: {
    status?: 'enabled' | 'disabled' | 'removed';
    trusted?: boolean;
    extensions?: string[];
  } = {},
) => ({
  managementRevision: 1,
  status: is.status ?? 'enabled',
  updatedAt: null,
  manifest: null,
  profiles: [],
  resource: {
    hash,
    name,
    version: '1.0.0',
    trustedAt: is.trusted === false ? null : '2026-01-01T00:00:00.000Z',
    license: null,
    skills: [],
    extensions: is.extensions ?? [],
    sourceKind: 'npm',
    sourceLabel: `npm:${name}@1.0.0`,
    files: [],
  },
});
const installed = [view('lint-pack', 'hash_1'), view('writing-skill', 'hash_2')];
const api = {
  packages: vi.fn(async () => installed),
  cancelReview: vi.fn(async (_id: string) => {}),
  reviewPackage: vi.fn(async (_kind: string, _source: string, _previous?: string) => ({
    reviewId: 'review_1',
    resource: view('fresh-pack', 'hash_3').resource,
    manifest: null,
    previous: null,
    changes: null,
  })),
  install: vi.fn(async (_id: string) => {}),
  trust: vi.fn(async (_hash: string, _trusted: boolean) => {}),
  managePackage: vi.fn(async () => {}),
};

const cleanup: (() => void)[] = [];
const scrolled: Element[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) act(dispose);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  api.packages.mockImplementation(async () => installed);
  navigation.item = undefined;
  lifecycle.leave = true;
  scrolled.length = 0;
});

async function show() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanup.push(() => {
    root.unmount();
    container.remove();
  });
  const page = () => (
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <PackageManager api={api as never} onChanged={() => {}} />
    </IntlProvider>
  );
  await act(async () => root.render(page()));
  return { container, rerender: () => act(async () => root.render(page())) };
}
const itemOf = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll('li')].find((li) => li.textContent?.startsWith(name));
const toggleOf = (item: Element | undefined) =>
  item?.querySelector<HTMLButtonElement>('button[aria-expanded]') ?? null;
/** What the closed row says: the text its own button is named by. */
const saidBy = (item: Element | undefined) =>
  (toggleOf(item)?.getAttribute('aria-labelledby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
/** The controls a person can reach in the row as it stands: nothing inside a closed fold. */
const reachable = (item: Element | undefined) =>
  [...(item?.querySelectorAll<HTMLElement>('button, [role="switch"]') ?? [])]
    .filter((control) => !control.closest('[inert]') && control !== toggleOf(item))
    .map(
      (control) =>
        document.getElementById(control.getAttribute('aria-labelledby') ?? '')?.textContent ??
        control.textContent,
    );
/** The fields a person fills in: the kit's own hidden inputs are not among them. */
const fields = (within: ParentNode | null) =>
  [
    ...(within?.querySelectorAll<HTMLInputElement>(
      'input:not([aria-hidden="true"]), [role="combobox"]',
    ) ?? []),
  ].filter((field) => field.type !== 'checkbox' && field.type !== 'hidden');
const sourceField = () =>
  fields(dialog()).find((field) => field.tagName === 'INPUT') as HTMLInputElement;
const button = (within: ParentNode, name: string) =>
  [...within.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === name,
  );
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const click = (target: Element | null | undefined) =>
  act(async () => (target as HTMLElement).click());
async function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function review(source = '/work/fresh-pack') {
  const container = (await show()).container;
  await click(button(container, messages.Packages.add));
  await type(sourceField(), source);
  await click(button(dialog() as HTMLElement, messages.Packages.review));
  return container;
}

// features/library.md: a package has no list to choose from, so Manage goes to its line and
// puts focus there.
it('scrolls to the package Manage carried and puts focus on it once the list has loaded', async () => {
  navigation.item = 'hash_2';
  const { container, rerender } = await show();
  const target = toggleOf(itemOf(container, 'writing-skill'));
  expect(target).toBeTruthy();
  expect(scrolled).toEqual([target]);
  expect(document.activeElement).toBe(target);
  // Once only: a later render does not pull focus back.
  button(container, messages.Packages.add)?.focus();
  await rerender();
  expect(scrolled).toHaveLength(1);
  expect(document.activeElement).not.toBe(target);
});

it('leaves focus and scroll alone when the carried key names no installed package', async () => {
  // A hook row's key starts with its package's hash; it is not that package.
  for (const item of ['hash_9', 'hash_1:extensions/hook.ts', undefined]) {
    navigation.item = item;
    const { container } = await show();
    expect(scrolled).toEqual([]);
    expect(container.contains(document.activeElement)).toBe(false);
    expect(container.querySelector('li[tabindex]')).toBeNull();
    for (const dispose of cleanup.splice(0)) act(dispose);
  }
});

it('opens on the list alone: the source form waits in a dialog whose choices are named', async () => {
  const { container } = await show();
  expect(fields(container)).toEqual([]);
  expect(dialog()).toBeNull();
  await click(button(container, messages.Packages.add));
  const form = dialog() as HTMLElement;
  expect(fields(form).map((field) => field.tagName)).toEqual(['BUTTON', 'INPUT', 'BUTTON']);
  for (const name of [messages.Packages.sourceKind, messages.Packages.compare])
    expect(form.textContent).toContain(name);
  // The comparison says what it stands at instead of an unnamed "Select…".
  expect(form.textContent).toContain(messages.Packages.newPackage);
});

it('says on a closed row only the state that differs, with the one thing that state asks for', async () => {
  api.packages.mockImplementation(async () => [
    view('usual', 'hash_1'),
    view('off', 'hash_2', { status: 'disabled' }),
    view('unknown', 'hash_3', { trusted: false, extensions: ['hook.ts'] }),
    view('unknown-and-off', 'hash_4', { trusted: false, status: 'disabled' }),
    view('gone', 'hash_5', { status: 'removed' }),
  ]);
  const { container } = await show();
  const { Packages: p, Harness: h, Resources: r } = messages;
  expect(saidBy(itemOf(container, 'usual'))).toBe('usual 1.0.0');
  expect(reachable(itemOf(container, 'usual'))).toEqual([]);
  expect(saidBy(itemOf(container, 'off'))).toBe(`off 1.0.0 ${p.disabled}`);
  expect(reachable(itemOf(container, 'off'))).toEqual([]);
  expect(saidBy(itemOf(container, 'unknown'))).toBe(`unknown 1.0.0 ${p.untrusted}`);
  expect(reachable(itemOf(container, 'unknown'))).toEqual([h.trust]);
  // The warning before trusting native code stays on the closed row.
  expect(itemOf(container, 'unknown')?.textContent).toContain(h.nativeWarning);
  expect(saidBy(itemOf(container, 'unknown-and-off'))).toBe(
    `unknown-and-off 1.0.0 ${p.untrusted} ${p.disabled}`,
  );
  expect(reachable(itemOf(container, 'unknown-and-off'))).toEqual([h.trust]);
  expect(saidBy(itemOf(container, 'gone'))).toBe(`gone 1.0.0 ${p.removed}`);
  expect(reachable(itemOf(container, 'gone'))).toEqual([r.restore]);
});

it('keeps the other actions at the end of the opened details, removal last, without repeating the row', async () => {
  api.packages.mockImplementation(async () => [
    view('usual', 'hash_1'),
    view('unknown', 'hash_3', { trusted: false }),
    view('gone', 'hash_5', { status: 'removed' }),
  ]);
  const { container } = await show();
  const { Packages: p, Harness: h, Resources: r } = messages;
  for (const name of ['usual', 'unknown', 'gone']) await click(toggleOf(itemOf(container, name)));
  expect(toggleOf(itemOf(container, 'usual'))?.getAttribute('aria-expanded')).toBe('true');
  expect(reachable(itemOf(container, 'usual'))).toEqual([p.enabled, h.revoke, p.remove]);
  expect(itemOf(container, 'usual')?.querySelector('[role="switch"]')?.ariaChecked).toBe('true');
  expect(reachable(itemOf(container, 'unknown'))).toEqual([h.trust, p.enabled, p.remove]);
  expect(reachable(itemOf(container, 'gone'))).toEqual([r.restore]);
  await click(button(itemOf(container, 'usual') as Element, h.revoke));
  expect(api.trust).toHaveBeenCalledWith('hash_1', false);
  // An action that goes away once done leaves the keyboard on its row.
  expect(document.activeElement).toBe(toggleOf(itemOf(container, 'usual')));
  await click(button(itemOf(container, 'unknown') as Element, h.trust));
  expect(document.activeElement).toBe(toggleOf(itemOf(container, 'unknown')));
  await click(button(itemOf(container, 'gone') as Element, r.restore));
  expect(document.activeElement).toBe(toggleOf(itemOf(container, 'gone')));
  await click(itemOf(container, 'usual')?.querySelector('[role="switch"]'));
  expect(api.managePackage).toHaveBeenCalledWith('hash_1', 1, 'disabled', expect.any(String));
  await click(button(itemOf(container, 'usual') as Element, p.remove));
  expect(api.managePackage).toHaveBeenLastCalledWith('hash_1', 1, 'removed', expect.any(String));
});

it('shows the reviewed copy in the same dialog and closes it once installed', async () => {
  const container = await review();
  expect(api.reviewPackage).toHaveBeenCalledWith('local', '/work/fresh-pack', undefined);
  expect(dialog()?.textContent).toContain(`${messages.Packages.reviewed} · fresh-pack · 1.0.0`);
  expect(container.textContent).not.toContain(messages.Packages.reviewed);
  // The keyboard lands on what was reviewed, not on the button that installs it.
  expect(document.activeElement?.getAttribute('aria-label')).toBe(messages.Packages.reviewed);
  await click(button(dialog() as HTMLElement, messages.Packages.install));
  expect(api.install).toHaveBeenCalledWith('review_1');
  expect(dialog()).toBeNull();
  expect(document.activeElement).toBe(button(container, messages.Packages.add));
  expect(api.cancelReview).not.toHaveBeenCalled();
  expect(api.packages).toHaveBeenCalledTimes(2);
});

it('asks before closing the dialog over a review, and cancels that review when the person leaves', async () => {
  await review();
  lifecycle.leave = false;
  await click(button(dialog() as HTMLElement, messages.Resources.cancel));
  expect(dialog()?.textContent).toContain(messages.Packages.reviewed);
  expect(api.cancelReview).not.toHaveBeenCalled();
  lifecycle.leave = true;
  await click(button(dialog() as HTMLElement, messages.Resources.cancel));
  expect(dialog()).toBeNull();
  expect(api.cancelReview).toHaveBeenCalledWith('review_1');
  expect(document.activeElement).toBe(button(document.body, messages.Packages.add));
  // Nothing of the abandoned review comes back with the next one.
  await click(button(document.body, messages.Packages.add));
  expect(sourceField().value).toBe('');
  expect(dialog()?.textContent).not.toContain(messages.Packages.reviewed);
});

it('says a refused review inside the dialog and a refused row action under the list', async () => {
  api.reviewPackage.mockRejectedValueOnce(new Error('The package is too large.'));
  const container = await review();
  expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe('The package is too large.');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await click(button(dialog() as HTMLElement, messages.Resources.cancel));
  api.trust.mockRejectedValueOnce(new Error('The package changed.'));
  await click(toggleOf(itemOf(container, 'lint-pack')));
  await click(button(itemOf(container, 'lint-pack') as Element, messages.Harness.revoke));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('The package changed.');
});

it('goes back to the source field when the person changes the source of a review', async () => {
  await review();
  await click(button(dialog() as HTMLElement, messages.Packages.changeSource));
  expect(api.cancelReview).toHaveBeenCalledWith('review_1');
  expect(sourceField().value).toBe('/work/fresh-pack');
  expect(document.activeElement).toBe(sourceField());
});
