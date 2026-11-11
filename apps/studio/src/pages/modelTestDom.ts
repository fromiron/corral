import type { ProviderAuthView } from '@corral/client';
import { act } from 'react';
import { vi } from 'vitest';

// Small DOM helpers for the model settings tests, which render with createRoot and act.

export function stubBrowser() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
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
  // jsdom lays nothing out; scrolling a row into view is a no-op there.
  Element.prototype.scrollIntoView ??= () => {};
}

const all = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document.body) =>
  [...root.querySelectorAll<T>(selector)] as T[];

/**
 * The text a sighted person sees: without the kit's hidden width-reserving copies and without
 * screen-reader-only names (read those with textContent or the accessible name).
 */
export function visibleText(node: Element | null | undefined): string {
  if (!node) return '';
  const copy = node.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"], .invisible, .sr-only'))
    hidden.remove();
  return copy.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

/** A button (or link, tab, option) by its accessible name or its visible text. */
export function control(name: string | RegExp, root: ParentNode = document.body) {
  const matches = (text: string | null | undefined) =>
    text != null && (typeof name === 'string' ? text.trim() === name : name.test(text));
  return all('button, a, [role="tab"], [role="option"], [role="menuitem"]', root).find(
    (el) => matches(el.getAttribute('aria-label')) || matches(visibleText(el)),
  );
}

/** A field by its accessible name: `aria-label`, or the text of its `<label>`. */
export function field(name: string, root: ParentNode = document.body) {
  const direct = all<HTMLInputElement>('input, textarea', root).find(
    (el) => el.getAttribute('aria-label') === name,
  );
  if (direct) return direct;
  const label = all<HTMLLabelElement>('label', root).find((el) => visibleText(el) === name);
  const id = label?.htmlFor;
  return (id ? document.getElementById(id) : label?.querySelector('input')) as
    | HTMLInputElement
    | null
    | undefined;
}

export async function click(el: Element | null | undefined) {
  if (!el) throw new Error('nothing to click');
  await act(async () => {
    (el as HTMLElement).click();
  });
}

export async function type(input: HTMLInputElement | null | undefined, value: string) {
  if (!input) throw new Error('no field to type into');
  await act(async () => {
    const proto =
      input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export async function key(target: Element | null | undefined, key: string) {
  if (!target) throw new Error('no key target');
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

/** Lets pending promises and timers settle inside act. */
export async function settle(ms = 0) {
  await act(async () => {
    await new Promise((done) => setTimeout(done, ms));
  });
}

export { all };

/** A provider as GET /model-auth reports it, signed out unless the patch says otherwise. */
export const provider = (patch: Partial<ProviderAuthView>): ProviderAuthView => ({
  providerId: 'openai',
  name: 'OpenAI',
  signedIn: false,
  method: null,
  methods: { oauth: true, apiKey: true },
  endpoint: null,
  endpointChanged: false,
  connectionTest: null,
  subscription: false,
  expiresAt: null,
  login: null,
  source: null,
  permissionsOk: true,
  modelCount: 0,
  modelFetch: null,
  ...patch,
});
