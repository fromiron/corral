import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ANNOTATE_CALLS } from '../src/annotate-overlay.ts';
import { annotateHandlers, browserHandlers } from '../src/browser-ipc.ts';
import type { BrowserTabs } from '../src/browser-tabs.ts';

function fakeTabs() {
  const calls: [string, unknown[]][] = [];
  const tabs = new Proxy(
    {},
    {
      get:
        (_target, name: string) =>
        (...args: unknown[]) => {
          calls.push([name, args]);
          return name === 'navigate' ? { ok: true } : undefined;
        },
    },
  ) as unknown as BrowserTabs;
  return { tabs, calls };
}

it('valid calls reach the tab manager as typed values', async () => {
  const { tabs, calls } = fakeTabs();
  const handlers = browserHandlers(tabs);
  const rect = { x: 0, y: 40.5, width: 600, height: 400 };
  await handlers['browser-navigate']?.('tab_1', 'project_1', 'example.com');
  await handlers['browser-place']?.('tab_1', rect);
  await handlers['browser-place']?.('tab_1', null);
  await handlers['browser-zoom']?.('tab_1', 'in');
  await handlers['browser-answer-permission']?.('tab_1', 'request-1', true);
  await handlers['browser-answer-login']?.('tab_1', 'request-2', { username: 'a', password: 'b' });
  await handlers['browser-answer-login']?.('tab_1', 'request-3', null);
  await handlers['browser-forget-permission']?.('project_1', 'https://a.example', 'camera');
  await handlers['browser-reset']?.('tab_1');
  await handlers['browser-annotate']?.('tab_1', true);
  await handlers['browser-annotate-context']?.('tab_1', { locale: 'ko', markers: [1, 2] });
  await handlers['browser-answer-annotate']?.('tab_1', 'submit-1', { kind: 'accepted' });
  await handlers['browser-set-shortcuts']?.({
    palette: { mod: true, key: 'k' },
    'reply.quote': { alt: true, key: 'q' },
  });
  expect(calls).toEqual([
    ['navigate', ['tab_1', 'project_1', 'example.com']],
    ['place', ['tab_1', rect]],
    ['place', ['tab_1', null]],
    ['zoom', ['tab_1', 'in']],
    ['answerPermission', ['tab_1', 'request-1', true]],
    ['answerLogin', ['tab_1', 'request-2', { username: 'a', password: 'b' }]],
    ['answerLogin', ['tab_1', 'request-3', null]],
    ['forgetPermission', ['project_1', 'https://a.example', 'camera']],
    ['reset', ['tab_1']],
    ['annotate', ['tab_1', true]],
    ['annotateContext', ['tab_1', { locale: 'ko', markers: [1, 2] }]],
    ['answerAnnotate', ['tab_1', 'submit-1', { kind: 'accepted' }]],
    ['setShortcuts', [[{ id: 'palette', key: 'k', mod: true }]]],
  ]);
});

it('malformed calls are refused before they reach a page', () => {
  const { tabs, calls } = fakeTabs();
  const handlers = browserHandlers(tabs);
  const bad: [string, unknown[]][] = [
    ['browser-navigate', ['tab 1', 'project_1', 'example.com']],
    ['browser-navigate', ['tab_1', 'project_1', 42]],
    ['browser-navigate', ['tab_1', '../project', 'example.com']],
    ['browser-place', ['tab_1', { x: 0, y: 0, width: -1, height: 10 }]],
    ['browser-place', ['tab_1', { x: Number.NaN, y: 0, width: 1, height: 10 }]],
    ['browser-place', ['tab_1', { x: 0, y: 0, width: 1, height: 10, z: 1 }]],
    ['browser-zoom', ['tab_1', 'max']],
    ['browser-answer-permission', ['tab_1', 'request-1', 'yes']],
    ['browser-answer-login', ['tab_1', 'request-1', { username: 'a' }]],
    ['browser-answer-login', ['tab_1', 'request-1', { username: 'a', password: 1 }]],
    ['browser-forget-permission', ['project_1', 'https://a.example', 'sudo']],
    ['browser-freeze', ['tab_1', { id: 1 }]],
    ['browser-reset', ['tab 1']],
    ['browser-reset', [{ tabId: 'tab_1' }]],
    ['browser-open-preview', ['tab_1', 'session 1', 'lease_1']],
    ['browser-set-shortcuts', [{ palette: { mod: true, key: 'Enter' } }]],
    ['browser-set-shortcuts', [[{ id: 'palette', mod: true, key: 'k' }]]],
    ['browser-capture-preview', ['tab_1', { screenshot: 'yes', console: false }]],
    ['browser-annotate', ['tab_1', 'on']],
    ['browser-annotate-context', ['tab_1', { big: 'x'.repeat(64 * 1024) }]],
    ['browser-annotate-context', ['tab_1', { loop: 1n }]],
    ['browser-answer-annotate', ['tab_1', 'submit 1', {}]],
    ['browser-answer-annotate', ['tab_1', 'submit-1', { big: 'x'.repeat(16 * 1024) }]],
  ];
  for (const [name, args] of bad) {
    const handler = handlers[name];
    expect(handler, name).toBeTypeOf('function');
    expect(() => handler?.(...args), name).toThrow();
  }
  expect(calls).toEqual([]);
});

it('the preload exposes exactly these calls, by name, and nothing generic', () => {
  const preload = readFileSync(resolve(import.meta.dirname, '../src/preload.cjs'), 'utf8');
  const exposed = [...preload.matchAll(/'desktop:(browser-[a-z-]+)'/g)].map((match) => match[1]);
  const channels = Object.keys(browserHandlers(fakeTabs().tabs));
  expect(new Set(exposed)).toEqual(new Set([...channels, 'browser-event']));
  expect(preload).not.toMatch(/ipcRenderer\.(send|invoke)\(\s*[a-z]/);
});

it('a renderer handler never sees the event object', () => {
  const tabs = { reload: vi.fn() } as unknown as BrowserTabs;
  browserHandlers(tabs)['browser-reload']?.('tab_1');
  expect((tabs.reload as ReturnType<typeof vi.fn>).mock.calls).toEqual([['tab_1']]);
});

it("the overlay's calls go to the tab manager with their sender and frame, each by name", async () => {
  const seen: unknown[][] = [];
  const tabs = {
    fromOverlay: (...args: unknown[]) => {
      seen.push(args);
      return 'answer';
    },
  } as unknown as BrowserTabs;
  const handlers = annotateHandlers(tabs);
  expect(Object.keys(handlers)).toEqual(ANNOTATE_CALLS.map((name) => `annotate:${name}`));
  const sender = { id: 7 };
  const frame = { url: 'corral-overlay://overlay/annotate.html' };
  expect(
    await handlers['annotate:pick']?.({ sender, senderFrame: frame } as never, { x: 1, y: 2 }),
  ).toBe('answer');
  expect(seen).toEqual([[sender, frame, 'pick', [{ x: 1, y: 2 }]]]);
});

it("the overlay's preload exposes exactly its calls under corralAnnotate, and nothing of the app", () => {
  const preload = readFileSync(resolve(import.meta.dirname, '../src/annotate-preload.cjs'), 'utf8');
  const invoked = [...preload.matchAll(/ipcRenderer\.invoke\('annotate:([a-z-]+)'/g)].map(
    (match) => match[1],
  );
  expect(new Set(invoked)).toEqual(new Set(ANNOTATE_CALLS));
  expect([...preload.matchAll(/ipcRenderer\.on\('([^']+)'/g)].map((match) => match[1])).toEqual([
    'annotate:event',
  ]);
  expect(preload).toMatch(/exposeInMainWorld\(\s*'corralAnnotate'/);
  expect(preload).not.toMatch(/corralDesktop|desktop:|ipcRenderer\.(send|invoke)\(\s*[a-z]/);
});
