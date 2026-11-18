// Small stand-ins for the Electron objects the browser tab manager drives.
import { EventEmitter } from 'node:events';
import type { Session, WebContents, WebContentsView } from 'electron';
import { vi } from 'vitest';
import type { BrowserEvent } from '../src/browser-bridge.ts';
import type { BrowserFiles } from '../src/browser-permissions.ts';
import { BrowserTabs, type BrowserTabsPorts } from '../src/browser-tabs.ts';

let nextContentsId = 1;

export class FakeContents extends EventEmitter {
  id = nextContentsId++;
  url = '';
  title = '';
  destroyed = false;
  zoom = 0;
  mainFrame = {};
  openHandler: ((details: { url: string }) => Record<string, unknown>) | null = null;
  history = { back: false, forward: false };
  navigationHistory = {
    canGoBack: () => this.history.back,
    canGoForward: () => this.history.forward,
    goBack: vi.fn(),
    goForward: vi.fn(),
  };
  loadURL = vi.fn(async (url: string) => {
    this.url = url;
  });
  reload = vi.fn();
  stop = vi.fn();
  focus = vi.fn();
  setWebRTCIPHandlingPolicy = vi.fn();
  capturePage = vi.fn(async () => ({
    isEmpty: () => false,
    toDataURL: () => 'data:image/png;base64,still',
    getSize: () => ({ width: 400, height: 300 }),
  }));
  executeJavaScriptInIsolatedWorld = vi.fn();
  setWindowOpenHandler(handler: (details: { url: string }) => Record<string, unknown>) {
    this.openHandler = handler;
  }
  getURL() {
    return this.url;
  }
  getTitle() {
    return this.title;
  }
  getZoomLevel() {
    return this.zoom;
  }
  setZoomLevel(level: number) {
    this.zoom = level;
  }
  isDestroyed() {
    return this.destroyed;
  }
  close = vi.fn(() => {
    this.destroy();
  });
  /** The page itself going away (window.close()). */
  destroy() {
    if (this.destroyed) return;
    this.emit('close', { preventDefault() {} });
    this.destroyed = true;
    this.emit('destroyed');
  }
  /** A main-frame navigation that commits. */
  commit(url: string, title = '') {
    this.url = url;
    this.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false });
    this.emit('did-navigate', {}, url, 200, 'OK');
    if (title) {
      this.title = title;
      this.emit('page-title-updated', {}, title, true);
    }
  }
  /** A main-frame navigation that fails. */
  fail(url: string, code: number) {
    this.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false });
    this.emit('did-fail-load', {}, code, 'error', url, true, 1, 1);
  }
  key(input: Record<string, unknown>) {
    const event = { preventDefault: vi.fn() };
    this.emit('before-input-event', event, {
      type: 'keyDown',
      key: '',
      code: '',
      shift: false,
      control: false,
      alt: false,
      meta: false,
      isComposing: false,
      isAutoRepeat: false,
      location: 0,
      modifiers: [],
      ...input,
    });
    return event;
  }
  /** window.open from the page; returns what the handler answered. */
  open(url: string) {
    if (!this.openHandler) throw new Error('No window open handler');
    return this.openHandler({
      url,
      frameName: '',
      features: '',
      disposition: 'foreground-tab',
      referrer: { url: '', policy: 'default' },
    } as unknown as { url: string });
  }
}

export class FakeView {
  webContents: FakeContents;
  bounds: unknown = null;
  visible = true;
  init: unknown;
  constructor(init: unknown, contents?: FakeContents) {
    this.init = init;
    this.webContents = contents ?? new FakeContents();
  }
  setBounds(bounds: unknown) {
    this.bounds = bounds;
  }
  setVisible(visible: boolean) {
    this.visible = visible;
  }
}

export class FakeSession extends EventEmitter {
  name: string;
  requestHandler: ((...args: unknown[]) => void) | null = null;
  checkHandler: ((...args: unknown[]) => boolean) | null = null;
  deviceHandler: ((...args: unknown[]) => boolean) | null = null;
  webRequestHandlers: string[] = [];
  clearStorageData = vi.fn(async () => {});
  clearCache = vi.fn(async () => {});
  clearAuthCache = vi.fn(async () => {});
  webRequest = {
    onBeforeRequest: () => this.webRequestHandlers.push('onBeforeRequest'),
    onBeforeSendHeaders: () => this.webRequestHandlers.push('onBeforeSendHeaders'),
    onHeadersReceived: () => this.webRequestHandlers.push('onHeadersReceived'),
  };
  constructor(name: string) {
    super();
    this.name = name;
  }
  setPermissionRequestHandler(handler: (...args: unknown[]) => void) {
    this.requestHandler = handler;
  }
  setPermissionCheckHandler(handler: (...args: unknown[]) => boolean) {
    this.checkHandler = handler;
  }
  setDevicePermissionHandler(handler: (...args: unknown[]) => boolean) {
    this.deviceHandler = handler;
  }
  /** A page permission request; resolves with the answer. */
  request(
    contents: FakeContents,
    permission: string,
    details: Record<string, unknown> = {},
  ): { answer: boolean | undefined } {
    const result: { answer: boolean | undefined } = { answer: undefined };
    this.requestHandler?.(
      contents,
      permission,
      (allow: boolean) => {
        result.answer = allow;
      },
      { requestingUrl: contents.url, isMainFrame: true, ...details },
    );
    return result;
  }
}

export class FakeItem extends EventEmitter {
  savePath = '';
  filename: string;
  state = 'progressing';
  received = 0;
  total = 1000;
  dialogOptions: unknown = null;
  constructor(filename: string) {
    super();
    this.filename = filename;
  }
  setSaveDialogOptions(options: unknown) {
    this.dialogOptions = options;
  }
  getSavePath() {
    return this.savePath;
  }
  getFilename() {
    return this.filename;
  }
  getReceivedBytes() {
    return this.received;
  }
  getTotalBytes() {
    return this.total;
  }
  getState() {
    return this.state;
  }
  cancel = vi.fn(() => {
    if (this.state !== 'progressing') return;
    this.state = 'cancelled';
    this.emit('done', {}, 'cancelled');
  });
  progress(received: number) {
    this.received = received;
    this.emit('updated', {}, 'progressing');
  }
  finish() {
    this.received = this.total;
    this.state = 'completed';
    this.emit('done', {}, 'completed');
  }
}

export function memoryFiles() {
  const files = new Map<string, string>();
  const io: BrowserFiles = {
    read: (name) => files.get(name) ?? null,
    write: (name, text) => void files.set(name, text),
    remove: (name) => void files.delete(name),
  };
  return { files, io };
}

export function setup(options: { files?: BrowserFiles; mac?: boolean } = {}) {
  const events: BrowserEvent[] = [];
  const sessions = new Map<string, FakeSession>();
  const views: FakeView[] = [];
  const children = new Set<FakeView>();
  const timers: (() => void)[] = [];
  let time = 10_000;
  let ids = 0;
  const lease = {
    url: 'http://127.0.0.2:4321/key-path/index.html',
    origin: 'http://127.0.0.2:4321',
    pathPrefix: '/key-path/',
    headers: { 'x-corral-preview': 'lease-token' },
  };
  const ports = {
    surface: () => ({
      addChildView: (view: FakeView) => void children.add(view),
      removeChildView: (view: FakeView) => void children.delete(view),
    }),
    session: (name: string) => {
      let fake = sessions.get(name);
      if (!fake) {
        fake = new FakeSession(name);
        sessions.set(name, fake);
      }
      return fake as unknown as Session;
    },
    createView: (init: { session?: Session; contents?: WebContents }) => {
      const view = new FakeView(init, init.contents as unknown as FakeContents | undefined);
      views.push(view);
      return view as unknown as WebContentsView;
    },
    send: (event: BrowserEvent) => void events.push(structuredClone(event)),
    focusHost: vi.fn(),
    hostZoom: () => 1.25,
    openExternal: vi.fn(),
    showItemInFolder: vi.fn(),
    resolveLease: vi.fn(async () => structuredClone(lease)),
    files: options.files ?? memoryFiles().io,
    removePartition: vi.fn(),
    hostKey: () => '/home/person/.config/Corral/workspaces/default',
    now: () => time,
    id: () => `id${++ids}`,
    every: (_ms: number, run: () => void) => {
      timers.push(run);
      return () => {
        const index = timers.indexOf(run);
        if (index >= 0) timers.splice(index, 1);
      };
    },
    korean: () => true,
    mac: options.mac ?? false,
  } satisfies Record<keyof BrowserTabsPorts, unknown>;
  const tabs = new BrowserTabs(ports as unknown as BrowserTabsPorts);
  const sessionOf = (view: FakeView) =>
    (view.init as { session?: unknown }).session as unknown as FakeSession;
  return {
    tabs,
    ports,
    events,
    sessions,
    views,
    children,
    lease,
    sessionOf,
    advance: (ms: number) => {
      time += ms;
    },
    tick: async () => {
      for (const run of [...timers]) run();
      await new Promise((done) => setTimeout(done, 0));
    },
    states: (tabId: string) =>
      events.flatMap((event) =>
        event.type === 'state' && event.state.tabId === tabId ? [event.state] : [],
      ),
    last: (tabId: string) => {
      const list = events.flatMap((event) =>
        event.type === 'state' && event.state.tabId === tabId ? [event.state] : [],
      );
      return list[list.length - 1];
    },
  };
}
