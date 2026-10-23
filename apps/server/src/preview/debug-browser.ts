import { assertOwnedBrowserOrigin } from '@corral/adapter-pi';
import { type Browser, type BrowserContext, chromium } from 'playwright-core';
import type { DesktopPreviewTarget } from './service.ts';

/** The endpoint is supplied only by the broker's attested inspector bridge. */
export async function prepareDebugBrowser(
  endpoint: string,
  target: DesktopPreviewTarget,
  live: () => Promise<boolean>,
): Promise<() => Promise<void>> {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let stopped = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    stopped = true;
    closing ??= (async () => {
      try {
        await context?.close();
      } finally {
        // A CDP-connected browser.close disconnects; the broker owns the OS process.
        await browser?.close();
      }
    })();
    return closing;
  };
  const allowed = async (url: string, kind: 'http' | 'websocket' = 'http') => {
    assertOwnedBrowserOrigin(url, target, kind);
    if (stopped || !(await live()) || stopped) throw new Error('Preview lease is closed');
  };
  try {
    const address = new URL(endpoint);
    if (
      address.protocol !== 'ws:' ||
      address.hostname !== '127.0.0.1' ||
      !address.port ||
      address.username ||
      address.password ||
      address.search ||
      address.hash ||
      !/^\/devtools\/browser\/[\w-]{1,100}$/.test(address.pathname)
    )
      throw new Error('Invalid owned inspector bridge');
    await allowed(target.url);
    browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
    await allowed(target.url);
    context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    await context.route('**/*', async (route) => {
      let response: Awaited<ReturnType<typeof route.fetch>> | undefined;
      try {
        const url = route.request().url();
        await allowed(url);
        response = await route.fetch({
          headers: { ...route.request().headers(), ...target.headers },
          maxRedirects: 0,
          timeout: 5000,
        });
        await allowed(url);
        if (response.status() >= 300 && response.status() < 400)
          throw new Error('Preview redirect is unavailable');
        await route.fulfill({ response });
      } catch {
        await route.abort('blockedbyclient').catch(() => {});
      } finally {
        await response?.dispose().catch(() => {});
      }
    });
    await context.routeWebSocket('**/*', async (socket) => {
      try {
        await allowed(socket.url(), 'websocket');
        socket.connectToServer();
      } catch {
        await socket.close().catch(() => {});
      }
    });
    // Chromium requires this origin-scoped permission for loopback HMR sockets.
    if (target.webSocketOrigins.length)
      await context.grantPermissions(['local-network-access'], { origin: target.origin });
    // Both guards are installed before a page can send these private headers.
    await context.setExtraHTTPHeaders(target.headers);
    context.on('page', (page) => {
      page.on('download', (download) => {
        void download.cancel().catch(() => {});
      });
    });
    await allowed(target.url);
    const page = await context.newPage();
    const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await allowed(target.url);
    if (!response?.ok()) throw new Error('Preview page is unavailable');
    return close;
  } catch {
    await close().catch(() => {});
    throw new Error('Owned preview browser could not start');
  }
}
