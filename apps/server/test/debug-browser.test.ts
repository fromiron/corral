import type { Route, WebSocketRoute } from 'playwright-core';
import { beforeEach, expect, it, vi } from 'vitest';
import { prepareDebugBrowser } from '../src/preview/debug-browser.ts';

const connect = vi.hoisted(() => vi.fn());
vi.mock('playwright-core', () => ({ chromium: { connectOverCDP: connect } }));

const target = {
  url: 'http://127.0.0.2:4317/owned/index.html',
  origin: 'http://127.0.0.2:4317',
  pathPrefix: '/owned',
  webSocketOrigins: ['ws://127.0.0.2:4317'],
  headers: { 'x-corral-preview': 'fixture-preview-credential' },
};

beforeEach(() => connect.mockReset());

function fixture() {
  let http!: (route: Route) => Promise<void>;
  let websocket!: (route: WebSocketRoute) => Promise<void>;
  const page = { goto: vi.fn(async () => ({ ok: () => true })), on: vi.fn() };
  const context = {
    route: vi.fn(async (_pattern, handler) => {
      http = handler;
    }),
    routeWebSocket: vi.fn(async (_pattern, handler) => {
      websocket = handler;
    }),
    grantPermissions: vi.fn(async () => {}),
    setExtraHTTPHeaders: vi.fn(async () => {}),
    on: vi.fn(),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {}),
  };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => {}) };
  connect.mockResolvedValue(browser);
  return {
    browser,
    context,
    page,
    http: (route: Route) => http(route),
    websocket: (route: WebSocketRoute) => websocket(route),
  };
}

function route(url: string, status = 200) {
  const response = { status: () => status, dispose: vi.fn(async () => {}) };
  const value = {
    request: () => ({ url: () => url, headers: () => ({ accept: '*/*' }) }),
    fetch: vi.fn(async () => response),
    abort: vi.fn(async () => {}),
    fulfill: vi.fn(async () => {}),
  };
  return { ...value, input: value as unknown as Route };
}

function socket(url: string) {
  const value = { url: () => url, connectToServer: vi.fn(), close: vi.fn(async () => {}) };
  return { ...value, input: value as unknown as WebSocketRoute };
}

it('gates private preview HTTP/WebSocket traffic, redirects and late lease revocation', async () => {
  const f = fixture();
  let live = true;
  const close = await prepareDebugBrowser(
    'ws://127.0.0.1:4517/devtools/browser/fixture',
    target,
    async () => live,
  );
  expect(f.browser.newContext).toHaveBeenCalledWith({
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  expect(f.context.setExtraHTTPHeaders.mock.invocationCallOrder[0]).toBeGreaterThan(
    f.context.routeWebSocket.mock.invocationCallOrder[0] ?? Infinity,
  );
  expect(f.context.grantPermissions).toHaveBeenCalledWith(['local-network-access'], {
    origin: target.origin,
  });
  expect(f.page.goto).toHaveBeenCalledWith(target.url, {
    waitUntil: 'domcontentloaded',
    timeout: 10000,
  });

  const allowed = route(target.url);
  await f.http(allowed.input);
  expect(allowed.fetch).toHaveBeenCalledWith({
    headers: { accept: '*/*', ...target.headers },
    maxRedirects: 0,
    timeout: 5000,
  });
  expect(allowed.fulfill).toHaveBeenCalledOnce();
  for (const url of [
    'http://127.0.0.1:4317/owned/a',
    `${target.origin}/other/a`,
    `http://user@127.0.0.2:4317/owned/a`,
  ]) {
    const blocked = route(url);
    await f.http(blocked.input);
    expect(blocked.fetch).not.toHaveBeenCalled();
    expect(blocked.abort).toHaveBeenCalledOnce();
  }
  const redirect = route(target.url, 302);
  await f.http(redirect.input);
  expect(redirect.fulfill).not.toHaveBeenCalled();
  expect(redirect.abort).toHaveBeenCalledOnce();
  const allowedSocket = socket('ws://127.0.0.2:4317/owned/hmr');
  await f.websocket(allowedSocket.input);
  expect(allowedSocket.connectToServer).toHaveBeenCalledOnce();
  const foreignSocket = socket('ws://127.0.0.1:4317/owned/hmr');
  await f.websocket(foreignSocket.input);
  expect(foreignSocket.connectToServer).not.toHaveBeenCalled();
  expect(foreignSocket.close).toHaveBeenCalledOnce();

  const pending = route(target.url);
  pending.fetch.mockImplementation(async () => {
    live = false;
    return { status: () => 200, dispose: vi.fn(async () => {}) };
  });
  await f.http(pending.input);
  expect(pending.fulfill).not.toHaveBeenCalled();
  const revoked = route(target.url);
  await f.http(revoked.input);
  expect(revoked.fetch).not.toHaveBeenCalled();
  await f.websocket(allowedSocket.input);
  expect(allowedSocket.connectToServer).toHaveBeenCalledOnce();
  await Promise.all([close(), close()]);
  expect(f.context.close).toHaveBeenCalledOnce();
  expect(f.browser.close).toHaveBeenCalledOnce();
});

it('cleans the created context on navigation failure without exposing a private URL', async () => {
  const f = fixture();
  f.page.goto.mockRejectedValue(new Error(`${target.url} ${target.headers['x-corral-preview']}`));
  await expect(
    prepareDebugBrowser('ws://127.0.0.1:4517/devtools/browser/fixture', target, async () => true),
  ).rejects.toThrow('Owned preview browser could not start');
  expect(f.context.close).toHaveBeenCalledOnce();
  expect(f.browser.close).toHaveBeenCalledOnce();
});
