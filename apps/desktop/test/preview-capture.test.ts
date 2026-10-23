import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ windows: [] as any[], views: [] as any[] }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Contents extends EventEmitter {
    url = '';
    mainFrame = {};
    destroyed = false;
    executeJavaScriptInIsolatedWorld = vi.fn(async () => ({
      element: {
        tag: 'button',
        role: null,
        selector: 'button:nth-of-type(1)',
        text: 'Save',
        bounds: { x: 10, y: 20, width: 100, height: 30 },
        styles: { color: 'rgb(0, 0, 0)' },
      },
      screenshotSafe: true,
    }));
    capturePage = vi.fn(async () => ({
      getSize: () => ({ width: 100, height: 30 }),
      toPNG: () => Buffer.from('png'),
    }));
    setWebRTCIPHandlingPolicy() {}
    setWindowOpenHandler() {}
    focus() {}
    getURL() {
      return this.url;
    }
    isDestroyed() {
      return this.destroyed;
    }
    async loadURL(url: string) {
      this.url = url;
      this.emit('did-start-navigation');
    }
    close() {
      this.destroyed = true;
      this.emit('destroyed');
    }
  }
  return {
    BrowserWindow: class extends EventEmitter {
      destroyed = false;
      contentView = { addChildView() {} };
      constructor() {
        super();
        state.windows.push(this);
      }
      getContentSize() {
        return [1000, 700];
      }
      isDestroyed() {
        return this.destroyed;
      }
      show() {}
      focus() {}
      close() {
        this.destroyed = true;
        this.emit('closed');
      }
    },
    WebContentsView: class {
      webContents = new Contents();
      constructor() {
        state.views.push(this);
      }
      setBounds() {}
    },
    session: {
      fromPartition: () => ({
        setPermissionCheckHandler() {},
        setPermissionRequestHandler() {},
        on() {},
        webRequest: { onBeforeRequest() {}, onBeforeSendHeaders() {}, onHeadersReceived() {} },
        clearStorageData: async () => {},
      }),
    },
  };
});

import { DesktopPreviews } from '../src/preview.ts';

const instances: DesktopPreviews[] = [];
afterEach(() => {
  for (const item of instances.splice(0)) item.closeAll();
  vi.useRealTimers();
  state.views = [];
  state.windows = [];
});
async function setup() {
  const target = {
    url: 'http://127.0.0.2:4321/private-key/page?secret=value#hash',
    origin: 'http://127.0.0.2:4321',
    pathPrefix: '/private-key/',
    headers: { 'x-corral-preview': 'private-token' },
  };
  const resolve = vi.fn(async () => target);
  const previews = new DesktopPreviews(resolve);
  instances.push(previews);
  await previews.open('session', 'lease');
  const wc = state.views[0].webContents;
  const choose = () =>
    wc.emit(
      'context-menu',
      { preventDefault: vi.fn() },
      { x: 20, y: 30, frame: wc.mainFrame, menuSourceType: 'mouse' },
    );
  const ready = () => vi.waitFor(() => expect(wc.listenerCount('context-menu')).toBe(1));
  return { previews, target, resolve, wc, choose, ready };
}

it('[TC-WBD-020-H] captures only the native selection and opted-in console/image, revalidating its lease', async () => {
  const f = await setup();
  f.wc.emit('console-message', { level: 'info', message: 'before selection mode' });
  const pending = f.previews.capture('session', 'lease', { screenshot: true, console: true });
  await f.ready();
  f.wc.emit('console-message', {
    level: 'warning',
    message: 'private-token http://127.0.0.2:4321/private-key/page?secret=value#hash',
  });
  f.choose();
  const result = await pending;
  expect(result).toMatchObject({
    sessionId: 'session',
    leaseId: 'lease',
    url: 'http://127.0.0.2:4321/page',
    sourceRevision: null,
    element: { tag: 'button', text: 'Save' },
    screenshot: { mime: 'image/png', width: 100, height: 30 },
  });
  expect(JSON.stringify(result)).not.toMatch(
    /private-token|private-key|secret=value|before selection mode/,
  );
  expect(result.console).toHaveLength(1);
  expect(f.wc.capturePage).toHaveBeenCalledWith({ x: 10, y: 20, width: 100, height: 30 });
  expect(f.wc.executeJavaScriptInIsolatedWorld.mock.calls[0]?.[0]).toBe(1001);
  expect(f.resolve).toHaveBeenCalledTimes(3);
  expect(f.wc.listenerCount('context-menu')).toBe(0);
});

it('[TC-WBD-020-N] discards a selected result if its lease changes while the DOM read is pending', async () => {
  const f = await setup();
  let finish!: (value: unknown) => void;
  const element = await f.wc.executeJavaScriptInIsolatedWorld();
  f.wc.executeJavaScriptInIsolatedWorld.mockImplementationOnce(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  const pending = f.previews.capture('session', 'lease', { screenshot: false, console: false });
  const rejected = expect(pending).rejects.toThrow();
  await f.ready();
  f.choose();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  f.target.headers['x-corral-preview'] = 'new-token';
  finish(element);
  await rejected;
  expect(f.wc.capturePage).not.toHaveBeenCalled();
});

it('[TC-WBD-020-F] escape, navigation, explicit cancellation and deadline end capture without closing the page', async () => {
  const f = await setup();
  for (const action of [
    () =>
      f.wc.emit(
        'before-input-event',
        { preventDefault: vi.fn() },
        { key: 'Escape', type: 'keyDown' },
      ),
    () => f.wc.emit('did-start-navigation'),
    () => f.previews.cancelCapture('session', 'lease'),
  ]) {
    const pending = f.previews.capture('session', 'lease', { screenshot: false, console: false });
    const rejected = expect(pending).rejects.toThrow();
    await f.ready();
    action();
    await rejected;
    expect(f.wc.listenerCount('context-menu')).toBe(0);
    expect(f.wc.isDestroyed()).toBe(false);
  }
  vi.useFakeTimers();
  const pending = f.previews.capture('session', 'lease', { screenshot: false, console: false });
  const rejected = expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(30000);
  await rejected;
  expect(f.wc.listenerCount('context-menu')).toBe(0);
});
