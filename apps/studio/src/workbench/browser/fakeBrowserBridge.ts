// A stand-in for the desktop's browser bridge (`window.corralDesktop.browser`,
// apps/desktop/src/browser-bridge.ts) with no native view: the tests' fake, and in a development
// build the one `?fakeDesktopBrowser=1` installs to look at the browser tab outside the desktop
// app. It is never part of a production bundle: main.tsx imports it only under
// `import.meta.env.DEV`, and a test checks the built bundle for the marker below.
import type {
  BrowserBridge,
  BrowserDownload,
  BrowserEvent,
  BrowserStill,
  BrowserTabState,
  SitePermission,
} from '../../../../desktop/src/browser-bridge.ts';

/** Found in no production bundle (fakeBrowserBridge.test.ts). */
export const FAKE_BROWSER_MARKER = 'corral-fake-browser-bridge-5c1e';

export interface FakeBrowserBridge extends BrowserBridge {
  readonly marker: typeof FAKE_BROWSER_MARKER;
  /** Every call, in order: the method's name and its arguments. */
  readonly calls: [string, ...unknown[]][];
  /** The calls to one method, as their arguments. */
  callsTo(name: keyof BrowserBridge): unknown[][];
  /** Sends an event as main would. */
  emit(event: BrowserEvent): void;
  /** Sends a tab's state, starting from what the fake last sent for it. */
  setState(tabId: string, patch: Partial<BrowserTabState>): void;
  /** What the fake last sent for a tab. */
  stateOf(tabId: string): BrowserTabState | undefined;
  /** The site permissions `sitePermissions` answers with. */
  permissions: { permission: SitePermission; allow: boolean }[];
  /**
   * What `still` answers: a picture, with the annotation overlay's (`overlay`) while that mode
   * is on, or null (the view stays live).
   */
  stillAnswer: BrowserStill | null;
  /** What `freeze` answers. */
  freezeAnswer: boolean;
}

export interface FakeBrowserOptions {
  /** Pages answer at once (tests) or after this many ms (a development build). */
  delay?: number;
}

const blank = (tabId: string, kind: BrowserTabState['kind']): BrowserTabState => ({
  tabId,
  kind,
  page: 'none',
  url: null,
  title: null,
  loading: false,
  canGoBack: false,
  canGoForward: false,
  failure: null,
  blocked: null,
  pageFocused: false,
});

/** What the fake opens: roughly the address field's rule (the desktop's is authoritative). */
function address(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  const port = scheme && /^\d+(?:[/?#]|$)/.test(text.slice(scheme[0].length));
  if (scheme && !port) return /^https?$/i.test(scheme[1] ?? '') ? text : null;
  const host = text.split(/[/:?#]/)[0] ?? '';
  return `${host === 'localhost' || host === '127.0.0.1' ? 'http' : 'https'}://${text}`;
}

export function createFakeBrowserBridge(options: FakeBrowserOptions = {}): FakeBrowserBridge {
  const listeners = new Set<(event: BrowserEvent) => void>();
  const states = new Map<string, BrowserTabState>();
  const history = new Map<string, { entries: string[]; index: number }>();
  const calls: [string, ...unknown[]][] = [];
  const later = (run: () => void) => {
    if (options.delay === undefined) queueMicrotask(run);
    else setTimeout(run, options.delay);
  };
  const emit = (event: BrowserEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  const setState = (tabId: string, patch: Partial<BrowserTabState>) => {
    const next = { ...(states.get(tabId) ?? blank(tabId, 'page')), ...patch, tabId };
    states.set(tabId, next);
    emit({ type: 'state', state: next });
  };
  const show = (tabId: string, url: string, kind: BrowserTabState['kind']) => {
    const entry = history.get(tabId) ?? { entries: [], index: -1 };
    setState(tabId, { kind, page: 'live', url, loading: true, failure: null, blocked: null });
    later(() => {
      const host = new URL(url).host;
      setState(tabId, {
        loading: false,
        title: kind === 'preview' ? null : host,
        canGoBack: entry.index > 0,
        canGoForward: entry.index < entry.entries.length - 1,
      });
    });
  };
  const go = (tabId: string, url: string, kind: BrowserTabState['kind']) => {
    const entry = history.get(tabId) ?? { entries: [], index: -1 };
    entry.entries = [...entry.entries.slice(0, entry.index + 1), url];
    entry.index = entry.entries.length - 1;
    history.set(tabId, entry);
    show(tabId, url, kind);
  };
  const step = (tabId: string, by: number) => {
    const entry = history.get(tabId);
    const url = entry?.entries[(entry?.index ?? 0) + by];
    if (!entry || !url) return;
    entry.index += by;
    show(tabId, url, states.get(tabId)?.kind ?? 'page');
  };
  const record =
    <A extends unknown[], R>(name: string, run: (...args: A) => R) =>
    (...args: A): R => {
      calls.push([name, ...args]);
      return run(...args);
    };
  const fake: FakeBrowserBridge = {
    marker: FAKE_BROWSER_MARKER,
    calls,
    callsTo: (name) => calls.filter(([called]) => called === name).map(([, ...args]) => args),
    emit,
    setState,
    stateOf: (tabId) => states.get(tabId),
    permissions: [],
    stillAnswer: null,
    freezeAnswer: true,
    navigate: record('navigate', async (tabId: string, _projectId: string, input: string) => {
      const url = address(input);
      if (!url) return { ok: false as const, reason: 'unsupported-address' as const };
      go(tabId, url, 'page');
      return { ok: true as const };
    }),
    openPreview: record(
      'openPreview',
      async (tabId: string, _sessionId: string, leaseId: string) => {
        go(tabId, `http://127.0.0.2:4100/${leaseId}/`, 'preview');
      },
    ),
    place: record('place', async () => {}),
    close: record('close', async (tabId: string) => {
      states.delete(tabId);
      history.delete(tabId);
    }),
    unload: record('unload', async () => {}),
    reload: record('reload', async (tabId: string) => {
      const state = states.get(tabId);
      if (state?.url) show(tabId, state.url, state.kind);
    }),
    stop: record('stop', async (tabId: string) => setState(tabId, { loading: false })),
    back: record('back', async (tabId: string) => step(tabId, -1)),
    forward: record('forward', async (tabId: string) => step(tabId, 1)),
    reopen: record('reopen', async (tabId: string) => {
      const state = states.get(tabId);
      history.delete(tabId);
      if (state?.url) go(tabId, state.url, state.kind);
    }),
    reset: record('reset', async (tabId: string) => {
      const state = states.get(tabId);
      if (!state) return;
      if (state.kind === 'preview') throw new Error('A preview tab is not reset.');
      history.delete(tabId);
      setState(tabId, { ...blank(tabId, 'page'), pageFocused: state.pageFocused });
    }),
    zoom: record('zoom', async () => {}),
    focus: record('focus', async () => {}),
    still: record('still', async () => fake.stillAnswer),
    freeze: record('freeze', async () => fake.freezeAnswer),
    thaw: record('thaw', async () => {}),
    answerPermission: record('answerPermission', async () => {}),
    sitePermissions: record('sitePermissions', async () => fake.permissions),
    forgetPermission: record('forgetPermission', async () => {}),
    answerLogin: record('answerLogin', async () => {}),
    proceedCertificate: record('proceedCertificate', async () => true),
    downloads: record('downloads', async (): Promise<BrowserDownload[]> => []),
    cancelDownload: record('cancelDownload', async () => {}),
    showDownload: record('showDownload', async () => {}),
    openBlocked: record('openBlocked', async () => true),
    clearProjectData: record('clearProjectData', async () => {}),
    removeProject: record('removeProject', async () => {}),
    setShortcuts: record('setShortcuts', async () => {}),
    capturePreview: record('capturePreview', async () => {
      throw new Error('The fake browser bridge captures nothing.');
    }),
    cancelPreviewCapture: record('cancelPreviewCapture', async () => {}),
    // Annotation (S6) is not drawn by the fake: the mode never turns on.
    annotate: record('annotate', async () => false),
    annotateContext: record('annotateContext', async () => {}),
    answerAnnotate: record('answerAnnotate', async () => {}),
    onEvent: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
  return fake;
}
