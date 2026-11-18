// A conversation's browser tabs over the desktop's bridge (features/browser-tab.md): one
// subscription to the bridge's events for the page, what each tab's page says now, and when a
// page is loaded, closed or unloaded. The tab bodies only draw what this keeps; the views live in
// the desktop and outlive any one render of a body.
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import type {
  BrowserBridge,
  BrowserDownload,
  BrowserEvent,
  BrowserTabState,
  SitePermission,
} from '../../../../desktop/src/browser-bridge.ts';
import type { OpenTab, PanelEvent, PanelState } from '../panel/model.ts';
import { pageAt, tabKey } from '../panel/tabs.ts';

export type BrowserTab = Extract<OpenTab, { kind: 'browser' }>;

/** A page's request for permissions, asked on the line under its tab's head. */
export interface PermissionAsk {
  requestId: string;
  origin: string;
  permissions: SitePermission[];
}

/** A site's HTTP sign-in request, asked in a dialog over its tab. */
export interface LoginAsk {
  requestId: string;
  origin: string;
}

const NO_ASKS: readonly PermissionAsk[] = [];
const NO_LOGINS: readonly LoginAsk[] = [];
const NO_DOWNLOADS: readonly BrowserDownload[] = [];

/** What the page of each browser tab says now, by tab ID; the bodies and the strip read it. */
export class BrowserPages {
  private readonly pages = new Map<string, BrowserTabState>();
  private readonly listeners = new Set<() => void>();
  private readonly focusAsks = new Map<string, number>();
  private readonly pageFocusAsks = new Set<string>();
  private readonly asks = new Map<string, readonly PermissionAsk[]>();
  private readonly logins = new Map<string, readonly LoginAsk[]>();
  private readonly downloads = new Map<string, BrowserDownload>();
  private readonly downloadLines = new Map<string, readonly BrowserDownload[]>();
  private version = 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get(tabId: string): BrowserTabState | undefined {
    return this.pages.get(tabId);
  }
  /** Changes with every change, for a reader of several tabs. */
  snapshot = () => this.version;
  set(state: BrowserTabState) {
    this.pages.set(state.tabId, state);
    this.changed();
  }
  /** The tab's page is gone (closed, unloaded): its lines go; a later load asks again. */
  drop(tabId: string) {
    this.pageFocusAsks.delete(tabId);
    const asked = this.asks.delete(tabId) || this.logins.delete(tabId);
    let lines = false;
    for (const [id, download] of this.downloads)
      if (download.tabId === tabId) {
        this.downloads.delete(id);
        lines = true;
      }
    if (lines) this.lineDownloads();
    if (this.pages.delete(tabId) || this.focusAsks.delete(tabId) || asked || lines) this.changed();
  }
  clear() {
    this.pages.clear();
    this.focusAsks.clear();
    this.pageFocusAsks.clear();
    this.asks.clear();
    this.logins.clear();
    this.downloads.clear();
    this.downloadLines.clear();
    this.changed();
  }
  /** The tab's open permission asks, oldest first. */
  asksOf(tabId: string): readonly PermissionAsk[] {
    return this.asks.get(tabId) ?? NO_ASKS;
  }
  /** An ask, or the same request again with what is still unanswered. */
  ask(tabId: string, ask: PermissionAsk) {
    const now = this.asksOf(tabId);
    const at = now.findIndex((open) => open.requestId === ask.requestId);
    this.asks.set(tabId, at < 0 ? [...now, ask] : now.map((open, i) => (i === at ? ask : open)));
    this.changed();
  }
  endAsk(tabId: string, requestId: string) {
    const now = this.asksOf(tabId);
    if (!now.some((open) => open.requestId === requestId)) return;
    this.asks.set(
      tabId,
      now.filter((open) => open.requestId !== requestId),
    );
    this.changed();
  }
  /** The tab's open sign-in requests, oldest first: the dialog asks the first. */
  loginsOf(tabId: string): readonly LoginAsk[] {
    return this.logins.get(tabId) ?? NO_LOGINS;
  }
  login(tabId: string, login: LoginAsk) {
    const now = this.loginsOf(tabId);
    if (now.some((open) => open.requestId === login.requestId)) return;
    this.logins.set(tabId, [...now, login]);
    this.changed();
  }
  endLogin(tabId: string, requestId: string) {
    const now = this.loginsOf(tabId);
    if (!now.some((open) => open.requestId === requestId)) return;
    this.logins.set(
      tabId,
      now.filter((open) => open.requestId !== requestId),
    );
    this.changed();
  }
  /** The downloads whose line is under the tab's head, oldest first. */
  downloadsOf(tabId: string): readonly BrowserDownload[] {
    return this.downloadLines.get(tabId) ?? NO_DOWNLOADS;
  }
  /** A download's news: cancelled, or with no tab of this conversation, it has no line. */
  download(download: BrowserDownload, shown: boolean) {
    if (download.state === 'cancelled' || !shown) {
      if (!this.downloads.delete(download.downloadId)) return;
    } else this.downloads.set(download.downloadId, download);
    this.lineDownloads();
    this.changed();
  }
  /** The tab moved to another page: the lines of downloads that ended there go. */
  pageMoved(tabId: string) {
    let gone = false;
    for (const [id, download] of this.downloads)
      if (download.tabId === tabId && download.state !== 'progressing') {
        this.downloads.delete(id);
        gone = true;
      }
    if (!gone) return;
    this.lineDownloads();
    this.changed();
  }
  private lineDownloads() {
    this.downloadLines.clear();
    for (const download of this.downloads.values()) {
      if (!download.tabId) continue;
      this.downloadLines.set(download.tabId, [
        ...(this.downloadLines.get(download.tabId) ?? []),
        download,
      ]);
    }
  }
  /** The page of that tab is to take the focus once it is live on screen (a page's new tab). */
  focusPage(tabId: string) {
    this.pageFocusAsks.add(tabId);
  }
  /** True once for a tab whose page was asked for the focus. */
  takePageFocus(tabId: string): boolean {
    return this.pageFocusAsks.delete(tabId);
  }
  /** The address field of that tab is to take the focus (a new tab, Shift+Escape). */
  focusAddress(tabId: string) {
    this.focusAsks.set(tabId, (this.focusAsks.get(tabId) ?? 0) + 1);
    this.changed();
  }
  /** How many times the address field of that tab was asked for the focus. */
  focusAsked(tabId: string): number {
    return this.focusAsks.get(tabId) ?? 0;
  }
  private changed() {
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

/** A conversation's browser tabs, for the bodies and the strip. */
export interface BrowserTabs {
  readonly bridge: BrowserBridge;
  readonly pages: BrowserPages;
  readonly sessionId: string;
  readonly projectId: string;
  /** Opens what the person typed in that tab's address field, in the project's storage. */
  navigate(
    tabId: string,
    address: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'unsupported-address' }>;
  /** Puts an ordinary tab back to an empty new tab: no page, no history, nothing remembered. */
  reset(tabId: string): Promise<void>;
}

const BrowserTabsContext = createContext<BrowserTabs | null>(null);

export function BrowserTabsProvider({
  value,
  children,
}: {
  value: BrowserTabs | null;
  children: ReactNode;
}) {
  return <BrowserTabsContext.Provider value={value}>{children}</BrowserTabsContext.Provider>;
}

export function useBrowserTabsContext(): BrowserTabs | null {
  return useContext(BrowserTabsContext);
}

/** What one tab's page says now; undefined until the desktop says anything of it. */
export function useBrowserPage(tabId: string): BrowserTabState | undefined {
  const tabs = useContext(BrowserTabsContext);
  return useSyncExternalStore(
    tabs?.pages.subscribe ?? noSubscribe,
    () => tabs?.pages.get(tabId),
    () => undefined,
  );
}

/** The tab's open permission asks. */
export function useBrowserAsks(tabId: string): readonly PermissionAsk[] {
  const tabs = useContext(BrowserTabsContext);
  return useSyncExternalStore(
    tabs?.pages.subscribe ?? noSubscribe,
    () => tabs?.pages.asksOf(tabId) ?? NO_ASKS,
    () => NO_ASKS,
  );
}

/** The tab's open sign-in requests. */
export function useBrowserLogins(tabId: string): readonly LoginAsk[] {
  const tabs = useContext(BrowserTabsContext);
  return useSyncExternalStore(
    tabs?.pages.subscribe ?? noSubscribe,
    () => tabs?.pages.loginsOf(tabId) ?? NO_LOGINS,
    () => NO_LOGINS,
  );
}

/** The downloads with a line under the tab's head. */
export function useBrowserDownloads(tabId: string): readonly BrowserDownload[] {
  const tabs = useContext(BrowserTabsContext);
  return useSyncExternalStore(
    tabs?.pages.subscribe ?? noSubscribe,
    () => tabs?.pages.downloadsOf(tabId) ?? NO_DOWNLOADS,
    () => NO_DOWNLOADS,
  );
}

/** Re-renders with any page's change: for the strip, which names every tab. */
export function useBrowserPages(): BrowserPages | null {
  const tabs = useContext(BrowserTabsContext);
  useSyncExternalStore(tabs?.pages.subscribe ?? noSubscribe, tabs?.pages.snapshot ?? zero, zero);
  return tabs?.pages ?? null;
}

const noSubscribe = () => () => {};
const withoutHash = (url: string) => url.split('#')[0];
const zero = () => 0;

export interface BrowserTabsInput {
  /** The desktop's bridge; null where there is no browser tab. */
  bridge: BrowserBridge | null | undefined;
  sessionId: string;
  projectId: string;
  /** The conversation's panel now. */
  state: PanelState;
  /** The panel is on screen (옆, 넓힘, 서랍): only then does choosing a tab load its page. */
  onScreen: boolean;
  dispatch: (event: PanelEvent) => void;
  /** The conversation now (an event for one left is dropped). */
  current: () => string;
  /** Makes a browser tab's ID, for a tab the page's menu asks for. */
  newId: () => string;
}

/**
 * The conversation's browser tabs (features/browser-tab.md 닫기와 떠나기, 새 창과 팝업, 계약):
 * - a tab's page loads when the tab is first chosen while the panel is on screen: a preview tab
 *   opens its lease, an ordinary page its remembered origin and path; a new tab stays empty;
 * - a tab the person closes closes its page (its own downloads end); a tab whose page closed
 *   itself as a new window is only taken off the strip;
 * - leaving the conversation unloads every page it loaded (downloads carry on);
 * - the bridge's events reach only the tabs of this conversation.
 */
export function useBrowserTabs(input: BrowserTabsInput): BrowserTabs | null {
  const { bridge, sessionId, projectId } = input;
  const latest = useRef(input);
  latest.current = input;
  const pages = useRef(new BrowserPages()).current;
  /** Pages loaded in a visit, by tab ID, with the conversation they were loaded in. */
  const loaded = useRef(new Map<string, string>());
  /** New-window tabs whose page is gone already: nothing to close. */
  const gone = useRef(new Set<string>());
  const value = useRef<BrowserTabs | null>(null);
  if (
    bridge &&
    (value.current?.bridge !== bridge ||
      value.current.sessionId !== sessionId ||
      value.current.projectId !== projectId)
  )
    value.current = {
      bridge,
      pages,
      sessionId,
      projectId,
      navigate: (tabId, address) => {
        loaded.current.set(tabId, sessionId);
        return bridge.navigate(tabId, projectId, address);
      },
      reset: async (tabId) => {
        await bridge.reset(tabId);
        const now = latest.current;
        if (now.current() === sessionId)
          now.dispatch({ type: 'browserAt', browserId: tabId, at: null });
      },
    };
  if (!bridge) value.current = null;

  // One subscription for the page: events of other conversations' tabs are not this one's.
  useEffect(() => {
    if (!bridge) return;
    // A tab of this conversation, or one it has just opened and not drawn yet.
    const own = (tabId: string) =>
      latest.current.state.tabs.some((tab) => tab.kind === 'browser' && tab.browserId === tabId) ||
      loaded.current.get(tabId) === latest.current.sessionId;
    return bridge.onEvent((event: BrowserEvent) => {
      const now = latest.current;
      if (now.current() !== now.sessionId) return;
      switch (event.type) {
        case 'state': {
          const { state } = event;
          if (!own(state.tabId)) return;
          // A move to another page (not a reload, not a jump within it) ends the lines of
          // downloads that finished on the page before.
          const before = pages.get(state.tabId)?.url;
          if (before && state.url && withoutHash(before) !== withoutHash(state.url))
            pages.pageMoved(state.tabId);
          pages.set(state);
          const tab = now.state.tabs.find(
            (open): open is BrowserTab => open.kind === 'browser' && open.browserId === state.tabId,
          );
          if (tab && !tab.lease && state.kind === 'page' && state.url) {
            const at = pageAt(state.url);
            if (at && (at.origin !== tab.at?.origin || at.path !== tab.at?.path))
              now.dispatch({ type: 'browserAt', browserId: state.tabId, at });
          }
          return;
        }
        case 'popup':
          if (!own(event.openerTabId)) return;
          // The desktop made the new window's page already; it takes the focus once shown.
          loaded.current.set(event.tabId, now.sessionId);
          pages.focusPage(event.tabId);
          now.dispatch({
            type: 'browserPopup',
            browserId: event.tabId,
            openerId: event.openerTabId,
          });
          return;
        case 'popup-closed':
          if (!own(event.tabId)) return;
          gone.current.add(event.tabId);
          now.dispatch({ type: 'browserGone', browserId: event.tabId });
          return;
        case 'open-link': {
          if (!own(event.tabId)) return;
          const tabId = now.newId();
          now.dispatch({ type: 'browserBeside', browserId: tabId, besideId: event.tabId });
          loaded.current.set(tabId, now.sessionId);
          pages.focusPage(tabId);
          void bridge.navigate(tabId, event.projectId, event.url).catch(() => {});
          return;
        }
        case 'leave':
          if (own(event.tabId)) pages.focusAddress(event.tabId);
          return;
        case 'permission':
          if (own(event.tabId))
            pages.ask(event.tabId, {
              requestId: event.requestId,
              origin: event.origin,
              permissions: event.permissions,
            });
          return;
        case 'permission-ended':
          pages.endAsk(event.tabId, event.requestId);
          return;
        case 'login':
          if (own(event.tabId))
            pages.login(event.tabId, { requestId: event.requestId, origin: event.origin });
          return;
        case 'login-ended':
          pages.endLogin(event.tabId, event.requestId);
          return;
        case 'download': {
          const { download } = event;
          pages.download(download, Boolean(download.tabId && own(download.tabId)));
          return;
        }
        default:
          return;
      }
    });
  }, [bridge, pages]);

  // A tab chosen while the panel is on screen loads its page, once in a visit.
  const selected = input.state.tabs.find(
    (tab): tab is BrowserTab => tab.kind === 'browser' && tabKey(tab) === input.state.selected,
  );
  const selectedId = selected?.browserId ?? null;
  const { onScreen } = input;
  useEffect(() => {
    const now = latest.current;
    if (!bridge || !selectedId || !onScreen) return;
    if (loaded.current.has(selectedId)) return;
    const tab = now.state.tabs.find(
      (open): open is BrowserTab => open.kind === 'browser' && open.browserId === selectedId,
    );
    if (!tab) return;
    if (tab.lease) {
      loaded.current.set(selectedId, now.sessionId);
      void bridge.openPreview(selectedId, now.sessionId, tab.lease).catch(() => {});
    } else if (tab.at) {
      loaded.current.set(selectedId, now.sessionId);
      void bridge
        .navigate(selectedId, now.projectId, `${tab.at.origin}${tab.at.path}`)
        .catch(() => {});
      // Downloads carry on while the conversation is left: their lines come back with the tab.
      void bridge.downloads(selectedId).then(
        (downloads) => {
          if (latest.current.current() !== now.sessionId) return;
          for (const download of downloads)
            if (download.tabId === selectedId) pages.download(download, true);
        },
        () => {},
      );
    }
  }, [bridge, selectedId, onScreen, pages]);

  // A tab gone from the strip: the person closed it (its page closes), or its page is gone.
  const tabIds = input.state.tabs
    .flatMap((tab) => (tab.kind === 'browser' ? [tab.browserId] : []))
    .join(',');
  useEffect(() => {
    if (!bridge) return;
    const open = new Set(tabIds ? tabIds.split(',') : []);
    for (const [tabId, visit] of [...loaded.current]) {
      // Another conversation's pages are left as leaving does, never closed.
      if (visit !== sessionId || open.has(tabId)) continue;
      loaded.current.delete(tabId);
      pages.drop(tabId);
      if (gone.current.delete(tabId)) continue;
      void bridge.close(tabId).catch(() => {});
    }
  }, [bridge, tabIds, pages, sessionId]);

  // Leaving the conversation unloads its pages. A remount in the same visit (StrictMode) is not
  // leaving: the unload waits a turn and the next run of this effect cancels it.
  const leaving = useRef<{ sessionId: string; timer: number } | null>(null);
  useEffect(() => {
    if (leaving.current?.sessionId === sessionId) {
      window.clearTimeout(leaving.current.timer);
      leaving.current = null;
    }
    if (!bridge) return;
    return () => {
      const timer = window.setTimeout(() => {
        if (leaving.current?.timer === timer) leaving.current = null;
        for (const [tabId, visit] of [...loaded.current]) {
          if (visit !== sessionId) continue;
          loaded.current.delete(tabId);
          gone.current.delete(tabId);
          pages.drop(tabId);
          void bridge.unload(tabId).catch(() => {});
        }
      }, 0);
      leaving.current = { sessionId, timer };
    };
  }, [bridge, sessionId, pages]);

  return value.current;
}
