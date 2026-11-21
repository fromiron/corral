import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type {
  AuthenticationResponseDetails,
  AuthInfo,
  BrowserWindowConstructorOptions,
  Certificate,
  ContextMenuParams,
  DownloadItem,
  Event,
  HandlerDetails,
  Input,
  PermissionRequest,
  Rectangle,
  Session,
  View,
  WebContents,
  WebContentsView,
  WebFrameMain,
  WebPreferences,
  WindowOpenHandlerResponse,
} from 'electron';
import {
  ANNOTATE_CALLS,
  configureOverlaySession,
  OVERLAY_ORIGIN,
  OVERLAY_PARTITION,
  overlayPreferences,
} from './annotate-overlay.ts';
import { TabAnnotation } from './browser-annotate.ts';
import type {
  BrowserDownload,
  BrowserEvent,
  BrowserFailure,
  BrowserPage,
  BrowserRect,
  BrowserStill,
  BrowserTabState,
} from './browser-bridge.ts';
import { type BrowserFiles, SitePermissionStore } from './browser-permissions.ts';
import {
  APP_PAGE_SHORTCUTS,
  browserAddress,
  type CertificateReason,
  certificateReason,
  isLoopbackHost,
  loadFailure,
  NewWindowActivation,
  type PageChord,
  type PageMenuItem,
  pageKey,
  pageMenu,
  permissionCheck,
  permissionRequest,
  refuseFullscreen,
  type SitePermission,
  systemBrowserUrl,
  webOrigin,
  zoomLevel,
} from './browser-policy.ts';
import {
  capturePreviewSelection,
  type PreviewCapture,
  type PreviewCaptureSurface,
  previewCaptureOptions,
} from './preview-capture.ts';
import { observationUrl } from './preview-observation.ts';
import {
  type DesktopPreviewTarget,
  previewRequestAllowed,
  validatePreviewTarget,
} from './preview-policy.ts';
import { applyLeaseRules } from './preview-session.ts';

/** What the manager needs from Electron and main; tests give it stand-ins. */
export interface BrowserTabsPorts {
  /** The window the page views are layered on; null when it is gone. */
  surface(): { addChildView(view: View): void; removeChildView(view: View): void } | null;
  /** The session for a partition: `persist:` names are kept, others live in memory. */
  session(partition: string): Session;
  createView(
    init: { session: Session; webPreferences: WebPreferences } | { contents: WebContents },
  ): WebContentsView;
  /** To the studio; main drops it when the window's page is not the trusted app. */
  send(event: BrowserEvent): void;
  /** Moves keyboard focus from a page to the app's own page. */
  focusHost(): void;
  /** The app page's zoom factor: a view's rectangle is the DOM rectangle times this. */
  hostZoom(): number;
  openExternal(url: string): void;
  showItemInFolder(path: string): void;
  /** The current preview target of a lease (from the server); throws when it is gone. */
  resolveLease(sessionId: string, leaseId: string): Promise<unknown>;
  /** Small files beside the browser storage (permission answers, partitions to remove). */
  files: BrowserFiles;
  /** Deletes a removed project's partition folder; runs at start, before any session opens. */
  removePartition(partition: string): void;
  /** This device's Corral host (its data folder); a project's partition is named with it. */
  hostKey(): string;
  now(): number;
  id(): string;
  /** Runs `run` every `ms`; returns the stop. */
  every(ms: number, run: () => void): () => void;
  /**
   * Shows the operating system's menu, a separator between groups: at `at` (window
   * coordinates) when given, otherwise at the pointer.
   */
  popupMenu(groups: { label: string; run: () => void }[][], at?: { x: number; y: number }): void;
  copyText(text: string): void;
  /** Runs `run` once after `ms`; returns the cancel. */
  after(ms: number, run: () => void): () => void;
  /** The annotation overlay's preload (annotate-preload.cjs). */
  overlayPreload(): string;
  /** A file of the studio's build for the overlay (`annotate.html`, `assets/…`); null if none. */
  overlayFile(path: string): Uint8Array | null;
  korean(): boolean;
  mac: boolean;
}

/** Still moving, or stopped where Chromium may resume it ('updated' said interrupted). */
const unfinished = (download: { state: BrowserDownload['state'] }) =>
  download.state === 'progressing' || download.state === 'interrupted';

/** The page menu's words (features/browser-tab.md 페이지의 메뉴): Korean, English. */
const MENU_LABELS: Record<PageMenuItem, [string, string]> = {
  'open-link': ['새 탭에서 링크 열기', 'Open link in new tab'],
  'copy-link': ['링크 주소 복사', 'Copy link address'],
  'copy-image': ['이미지 복사', 'Copy image'],
  cut: ['잘라내기', 'Cut'],
  copy: ['복사', 'Copy'],
  paste: ['붙여넣기', 'Paste'],
  'select-all': ['모두 선택', 'Select all'],
};

/** Both kinds of page: no preload, no Node, sandboxed and isolated; nothing of Corral exposed. */
const PAGE_PREFERENCES: WebPreferences = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  webviewTag: false,
  safeDialogs: true,
};
const REMOVED = 'removed-partitions.json';
const ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/;

interface Project {
  projectId: string;
  partition: string;
  session: Session;
  permissions: SitePermissionStore;
}

interface Lease {
  sessionId: string;
  leaseId: string;
  target: DesktopPreviewTarget;
  /** The tab's own in-memory session; null after the lease ended and it was cleared. */
  session: Session | null;
  stopWatch: (() => void) | null;
}

interface Ask {
  requestId: string;
  origin: string;
  /** The permissions not answered yet; the answer is remembered for these. */
  permissions: SitePermission[];
  /** Each request's own permissions, answered once all are known. */
  waiting: { permissions: SitePermission[]; done: (allow: boolean) => void }[];
}

interface Challenge {
  /** Null when there is no way past (not a loopback host). */
  id: string | null;
  url: string;
  hostname: string;
  fingerprint: string;
  reason: CertificateReason;
}

interface Tab {
  id: string;
  kind: 'page' | 'preview';
  project: Project | null;
  lease: Lease | null;
  view: WebContentsView | null;
  contents: WebContents | null;
  /** The live page was opened by another page (window.open, target=_blank). */
  popup: boolean;
  openerTabId: string | null;
  page: BrowserPage;
  url: string | null;
  title: string | null;
  loading: boolean;
  failure: BrowserFailure | null;
  blocked: { url: string | null } | null;
  focused: boolean;
  frozen: boolean;
  stillId: string | null;
  stillEpoch: number;
  challenge: Challenge | null;
  gate: NewWindowActivation;
  asks: Ask[];
  logins: Map<string, (username?: string, password?: string) => void>;
  capture: PreviewCaptureSurface | null;
  annotation: TabAnnotation;
}

interface Download {
  id: string;
  item: DownloadItem;
  /** The tab whose page started it: only the person closing that tab cancels it. */
  startedBy: string;
  shownOn: string | null;
  /** A save place was chosen; before that there is no line. */
  announced: boolean;
  state: BrowserDownload['state'];
}

/**
 * The session panel's browser tabs in the desktop app: one WebContentsView per tab, a
 * persistent storage per project for ordinary pages, a fresh in-memory one per preview tab, and
 * the page's permissions, sign-ins, certificates, downloads, new windows and keys.
 */
export class BrowserTabs {
  private readonly ports: BrowserTabsPorts;
  private readonly tabs = new Map<string, Tab>();
  private readonly byContents = new Map<number, Tab>();
  private readonly rects = new Map<string, Rectangle | null>();
  private readonly closes = new Map<string, number>();
  private readonly projects = new Map<string, Project>();
  private readonly transfers = new Map<string, Download>();
  /** "그래도 열기": (partition, host, certificate), until Corral quits. */
  private readonly trusted = new Set<string>();
  /** The annotation overlays' pages, by contents id, to the tab each belongs to. */
  private readonly overlays = new Map<number, Tab>();
  private overlaySession: Session | null = null;
  private shortcuts: readonly PageChord[] = APP_PAGE_SHORTCUTS;
  private generation = 0;

  constructor(ports: BrowserTabsPorts) {
    this.ports = ports;
    this.removeLeftPartitions();
  }

  // ---- opening ----

  navigate(
    tabId: string,
    projectId: string,
    address: string,
  ): { ok: true } | { ok: false; reason: 'unsupported-address' } {
    const url = browserAddress(address);
    if (!url) return { ok: false, reason: 'unsupported-address' };
    const project = this.project(projectId);
    let tab = this.tabs.get(tabId);
    if (tab && (tab.kind !== 'page' || tab.project !== project))
      throw new Error('This browser tab holds another kind of page');
    tab ??= this.newTab(tabId, 'page', project, null);
    const contents = tab.contents ?? this.attach(tab, this.pageView(project));
    // A typed address may stop or turn into a download without replacing the current document.
    // Publish the new address only on did-navigate or a main-frame failure.
    if (tab.page === 'none' || tab.page === 'closed-itself') {
      tab.title = null;
      this.show(tab, null);
    }
    void contents.loadURL(url).catch(() => {
      // A failed load arrives as did-fail-load.
    });
    return { ok: true };
  }

  async openPreview(tabId: string, sessionId: string, leaseId: string): Promise<void> {
    if (!ID.test(sessionId) || !ID.test(leaseId)) throw new Error('Invalid preview identity');
    const before = this.tabs.get(tabId);
    if (
      before &&
      (before.kind !== 'preview' ||
        before.lease?.sessionId !== sessionId ||
        before.lease?.leaseId !== leaseId)
    )
      throw new Error('This browser tab holds another kind of page');
    if (before?.contents) return;
    const closes = this.closes.get(tabId) ?? 0;
    const generation = this.generation;
    const target = structuredClone(
      validatePreviewTarget(await this.ports.resolveLease(sessionId, leaseId)),
    );
    if ((this.closes.get(tabId) ?? 0) !== closes || generation !== this.generation)
      throw new Error('The browser tab was closed');
    const tab =
      this.tabs.get(tabId) ??
      this.newTab(tabId, 'preview', null, {
        sessionId,
        leaseId,
        target,
        session: null,
        stopWatch: null,
      });
    const lease = tab.lease;
    if (!lease || tab.contents) return;
    if (lease.session && JSON.stringify(lease.target) !== JSON.stringify(target)) {
      void lease.session.clearStorageData().catch(() => {});
      lease.session = null;
    }
    lease.target = target;
    if (!lease.session) {
      lease.session = this.ports.session(`corral-preview-${this.ports.id()}`);
      applyLeaseRules(lease.session, target, { refuseFullscreen: true });
    }
    const contents = this.attach(
      tab,
      this.ports.createView({ session: lease.session, webPreferences: { ...PAGE_PREFERENCES } }),
    );
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    tab.capture = { contents, target, revision: 0, captureEpoch: 0 };
    this.watchLease(tab, lease);
    this.show(tab, target.url);
    try {
      await contents.loadURL(target.url);
    } catch {
      // A failed load arrives as did-fail-load.
    }
  }

  /** "다시 열기": the last address in a new page; history starts again, storage stays. */
  async reopen(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (tab?.page !== 'closed-itself') throw new Error('Nothing to reopen');
    const lease = tab.lease;
    if (lease) {
      // The same lease again; an ended lease shows "미리보기가 끝났습니다".
      try {
        await this.openPreview(tab.id, lease.sessionId, lease.leaseId);
      } catch (error) {
        if (this.tabs.get(tab.id) !== tab || tab.contents) throw error;
        this.endStorage(lease);
        tab.page = 'ended';
        this.emit(tab);
      }
      return;
    }
    const project = tab.project;
    if (!project || !tab.url) throw new Error('Nothing to reopen');
    const contents = this.attach(tab, this.pageView(project));
    this.show(tab, tab.url);
    void contents.loadURL(tab.url).catch(() => {});
  }

  // ---- placing ----

  place(tabId: string, rect: BrowserRect | null) {
    const zoom = this.ports.hostZoom();
    this.rects.set(
      tabId,
      rect
        ? {
            x: Math.round(rect.x * zoom),
            y: Math.round(rect.y * zoom),
            width: Math.round(rect.width * zoom),
            height: Math.round(rect.height * zoom),
          }
        : null,
    );
    const tab = this.tabs.get(tabId);
    if (tab) this.apply(tab);
  }

  focus(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab || !this.visible(tab)) return;
    // While annotating, the page area's keyboard is the overlay's.
    if (!tab.annotation.focus()) tab.contents?.focus();
  }

  /** Step 1 of the still-image swap: a picture of the live view, which stays live. */
  async still(tabId: string): Promise<BrowserStill | null> {
    const tab = this.tabs.get(tabId);
    const contents = tab?.contents;
    if (!tab || !contents || !this.visible(tab)) return null;
    const epoch = ++tab.stillEpoch;
    let image: Awaited<ReturnType<WebContents['capturePage']>>;
    let overlay: BrowserStill['overlay'];
    try {
      // The overlay over it is pictured too, to be painted as it showed.
      [image, overlay] = await Promise.all([contents.capturePage(), tab.annotation.picture()]);
    } catch {
      return null; // the view could not be drawn (seen in a hidden window); it stays live
    }
    if (tab.contents !== contents || tab.stillEpoch !== epoch || !this.visible(tab)) return null;
    if (image.isEmpty()) return null; // nothing drawn yet: the host keeps the live view
    const stillId = this.ports.id();
    tab.stillId = stillId;
    const size = image.getSize();
    return {
      stillId,
      dataUrl: image.toDataURL(),
      width: size.width,
      height: size.height,
      overlay,
    };
  }

  /** Step 2, once the host painted the picture: the live view hides. */
  freeze(tabId: string, stillId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab?.contents || !tab.stillId || tab.stillId !== stillId) return false;
    tab.frozen = true;
    this.apply(tab);
    return true;
  }

  thaw(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.stillEpoch++;
    tab.stillId = null;
    tab.frozen = false;
    this.apply(tab);
  }

  // ---- moving ----

  reload(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (tab) this.reloadTab(tab);
  }

  stop(tabId: string) {
    this.tabs.get(tabId)?.contents?.stop();
  }

  back(tabId: string) {
    const history = this.tabs.get(tabId)?.contents?.navigationHistory;
    if (history?.canGoBack()) history.goBack();
  }

  forward(tabId: string) {
    const history = this.tabs.get(tabId)?.contents?.navigationHistory;
    if (history?.canGoForward()) history.goForward();
  }

  zoom(tabId: string, zoom: 'in' | 'out' | 'reset') {
    const contents = this.tabs.get(tabId)?.contents;
    if (contents) contents.setZoomLevel(zoomLevel(contents.getZoomLevel(), zoom));
  }

  /** The app chords taken from pages (already validated by browser-ipc's pageShortcuts). */
  setShortcuts(chords: readonly PageChord[]) {
    this.shortcuts = chords;
  }

  // ---- closing ----

  /** The person closed the tab: its page unloads without asking; what it started is cancelled. */
  close(tabId: string) {
    this.closes.set(tabId, (this.closes.get(tabId) ?? 0) + 1);
    this.rects.delete(tabId);
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.dispose(tab);
    for (const download of this.transfers.values()) {
      if (download.shownOn !== tab.id) continue;
      download.shownOn = null;
      if (download.startedBy === tab.id && unfinished(download)) download.item.cancel();
      else if (download.announced) this.sendDownload(download);
    }
    if (tab.lease) this.endStorage(tab.lease);
    this.forget(tab);
  }

  /** The conversation was left: the page unloads; downloads and the tab's storage stay. */
  unload(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.dispose(tab);
    tab.lease?.stopWatch?.();
    if (tab.lease) tab.lease.stopWatch = null;
    tab.popup = false;
    tab.page = 'none';
    tab.loading = false;
    tab.failure = null;
    tab.blocked = null;
    tab.focused = false;
    this.emit(tab);
  }

  /** An ordinary tab back to an empty new tab: no page, address, title or history; its storage stays. */
  reset(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    if (tab.kind !== 'page') throw new Error('Only an ordinary browser tab can be emptied');
    this.dispose(tab);
    tab.popup = false;
    tab.openerTabId = null;
    tab.page = 'none';
    tab.url = null;
    tab.title = null;
    tab.loading = false;
    tab.failure = null;
    tab.blocked = null;
    tab.focused = false;
    this.emit(tab);
  }

  /** The app page reloaded or went away: every page unloads. */
  unloadAll() {
    this.generation++;
    for (const tab of [...this.tabs.values()]) this.unload(tab.id);
  }

  /** The workspace changes or Corral quits: every tab goes; downloads carry on without a line. */
  closeAll() {
    this.generation++;
    for (const tab of [...this.tabs.values()]) {
      this.dispose(tab);
      if (tab.lease) this.endStorage(tab.lease);
      this.tabs.delete(tab.id);
    }
    this.rects.clear();
    for (const download of this.transfers.values()) download.shownOn = null;
  }

  // ---- answers from the host ----

  answerPermission(tabId: string, requestId: string, allow: boolean) {
    const tab = this.tabs.get(tabId);
    const ask = tab?.asks.find((entry) => entry.requestId === requestId);
    const project = tab?.project;
    if (!tab || !ask || !project) return;
    for (const permission of ask.permissions)
      project.permissions.set(ask.origin, permission, allow);
    this.settle(project, ask.origin);
  }

  sitePermissions(projectId: string, origin: string) {
    const site = webOrigin(origin);
    return site ? this.project(projectId).permissions.list(site) : [];
  }

  forgetPermission(projectId: string, origin: string, permission: SitePermission) {
    const site = webOrigin(origin);
    if (site) this.project(projectId).permissions.forget(site, permission);
  }

  answerLogin(
    tabId: string,
    requestId: string,
    credentials: { username: string; password: string } | null,
  ) {
    const tab = this.tabs.get(tabId);
    const callback = tab?.logins.get(requestId);
    if (!tab || !callback) return;
    tab.logins.delete(requestId);
    if (credentials) callback(credentials.username, credentials.password);
    else callback();
    this.ports.send({ type: 'login-ended', tabId, requestId });
  }

  proceedCertificate(tabId: string, challengeId: string): boolean {
    const tab = this.tabs.get(tabId);
    const challenge = tab?.challenge;
    if (
      !tab?.project ||
      !tab.contents ||
      !challenge?.id ||
      challenge.id !== challengeId ||
      tab.page !== 'failed'
    )
      return false;
    this.trusted.add(this.certificateKey(tab.project, challenge.hostname, challenge.fingerprint));
    tab.challenge = null;
    void tab.contents.loadURL(challenge.url).catch(() => {});
    return true;
  }

  downloads(tabId: string): BrowserDownload[] {
    return [...this.transfers.values()]
      .filter((download) => download.announced && download.shownOn === tabId)
      .map((download) => this.downloadState(download));
  }

  cancelDownload(downloadId: string) {
    const download = this.transfers.get(downloadId);
    if (download && unfinished(download)) download.item.cancel();
  }

  showDownload(downloadId: string) {
    const download = this.transfers.get(downloadId);
    if (download?.state === 'completed' && download.item.getSavePath())
      this.ports.showItemInFolder(download.item.getSavePath());
  }

  openBlocked(tabId: string): boolean {
    const url = this.tabs.get(tabId)?.blocked?.url;
    if (!url) return false;
    this.ports.openExternal(url);
    return true;
  }

  // ---- project storage ----

  async clearProjectData(projectId: string) {
    const project = this.project(projectId);
    for (const tab of this.tabsOf(project)) {
      this.endAsks(tab);
      this.endLogins(tab);
    }
    await this.clearStorage(project);
    project.permissions.clear();
    for (const tab of this.tabsOf(project))
      if (tab.contents && (tab.page === 'live' || tab.page === 'failed')) tab.contents.reload();
  }

  async removeProject(projectId: string) {
    const project = this.project(projectId);
    for (const tab of this.tabsOf(project)) this.close(tab.id);
    await this.clearStorage(project);
    project.permissions.clear();
    for (const key of [...this.trusted])
      if (key.startsWith(`${project.partition}\n`)) this.trusted.delete(key);
    this.projects.delete(project.partition);
    const removed = this.leftPartitions();
    if (!removed.includes(project.partition))
      this.ports.files.write(REMOVED, JSON.stringify([...removed, project.partition]));
  }

  // ---- annotation (browser-annotate.md) ----

  /** The mode on or off over the tab's page; on: false when the tab shows no live page. */
  annotate(tabId: string, on: boolean): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    if (on) return tab.annotation.turnOn();
    tab.annotation.turnOff();
    return false;
  }

  annotateContext(tabId: string, context: unknown) {
    this.tabs.get(tabId)?.annotation.setContext(context);
  }

  answerAnnotate(tabId: string, submitId: string, outcome: unknown) {
    this.tabs.get(tabId)?.annotation.answer(submitId, outcome);
  }

  /** A call from an overlay's page: only a live overlay's main frame on its own page. */
  async fromOverlay(
    sender: WebContents,
    frame: WebFrameMain | null | undefined,
    name: string,
    args: unknown[],
  ): Promise<unknown> {
    const tab = this.overlays.get(sender.id);
    if (
      !tab ||
      tab.annotation.overlay() !== sender ||
      !frame ||
      frame !== sender.mainFrame ||
      !frame.url.startsWith(`${OVERLAY_ORIGIN}/`)
    )
      throw new Error('Untrusted annotate request');
    if (!(ANNOTATE_CALLS as readonly string[]).includes(name))
      throw new Error('Unknown annotate request');
    return tab.annotation.call(name, args);
  }

  // ---- element capture on a preview tab ----

  async capturePreview(tabId: string, raw: unknown): Promise<PreviewCapture> {
    const options = previewCaptureOptions(raw);
    const tab = this.tabs.get(tabId);
    const surface = tab?.capture;
    const lease = tab?.lease;
    if (tab?.kind !== 'preview' || !surface || !lease || tab.contents !== surface.contents)
      throw new Error('Open this preview first');
    this.cancelCapture(tab);
    return capturePreviewSelection({
      sessionId: lease.sessionId,
      leaseId: lease.leaseId,
      surface,
      options,
      alive: () => tab.capture === surface && tab.contents === surface.contents,
      resolveTarget: () => this.ports.resolveLease(lease.sessionId, lease.leaseId),
      cancel: () => this.cancelCapture(tab),
      reveal: () => {},
    });
  }

  cancelPreviewCapture(tabId: string) {
    const tab = this.tabs.get(tabId);
    if (tab) this.cancelCapture(tab);
  }

  // ---- internals ----

  private newTab(id: string, kind: Tab['kind'], project: Project | null, lease: Lease | null) {
    const tab: Tab = {
      id,
      kind,
      project,
      lease,
      view: null,
      contents: null,
      popup: false,
      openerTabId: null,
      page: 'none',
      url: null,
      title: null,
      loading: false,
      failure: null,
      blocked: null,
      focused: false,
      frozen: false,
      stillId: null,
      stillEpoch: 0,
      challenge: null,
      gate: new NewWindowActivation(this.ports.now),
      asks: [],
      logins: new Map(),
      capture: null,
      annotation: null as unknown as TabAnnotation,
    };
    tab.annotation = this.annotationOf(tab);
    this.tabs.set(id, tab);
    return tab;
  }

  private annotationOf(tab: Tab): TabAnnotation {
    return new TabAnnotation({
      tabId: tab.id,
      kind: tab.kind,
      page: () =>
        tab.page === 'live' && tab.contents && !tab.contents.isDestroyed() ? tab.contents : null,
      lease: () => tab.lease,
      resolveLease: () => {
        const lease = tab.lease;
        if (!lease) return Promise.reject(new Error('No lease'));
        return this.ports.resolveLease(lease.sessionId, lease.leaseId);
      },
      rect: () => this.rects.get(tab.id) ?? null,
      shown: () => this.visible(tab),
      hostZoom: () => this.ports.hostZoom(),
      createOverlay: () =>
        this.ports.createView({
          session: this.overlayPartition(),
          webPreferences: overlayPreferences(this.ports.overlayPreload(), this.ports.hostZoom()),
        }),
      addView: (view) => this.ports.surface()?.addChildView(view),
      removeView: (view) => {
        try {
          this.ports.surface()?.removeChildView(view);
        } catch {
          // The view already left the window.
        }
      },
      send: (event) => {
        if (this.tabs.get(tab.id) === tab) this.ports.send(event);
      },
      key: (event, input) => this.onKey(tab, event, input),
      focusChanged: (focused) => {
        tab.focused = focused;
      },
      overlayOpened: (contents) => void this.overlays.set(contents.id, tab),
      overlayClosed: (contents) => void this.overlays.delete(contents.id),
      now: () => this.ports.now(),
      id: () => this.ports.id(),
      after: (ms, run) => this.ports.after(ms, run),
    });
  }

  /** The overlays' one in-memory partition, its rules set the first time. */
  private overlayPartition(): Session {
    if (!this.overlaySession) {
      this.overlaySession = this.ports.session(OVERLAY_PARTITION);
      configureOverlaySession(this.overlaySession, (path) => this.ports.overlayFile(path));
    }
    return this.overlaySession;
  }

  private pageView(project: Project) {
    return this.ports.createView({
      session: project.session,
      webPreferences: { ...PAGE_PREFERENCES },
    });
  }

  private project(projectId: string): Project {
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(projectId)) throw new Error('Invalid project');
    const digest = createHash('sha256')
      .update(`${this.ports.hostKey()}\0${projectId}`)
      .digest('hex')
      .slice(0, 32);
    const partition = `persist:corral-browser-${digest}`;
    const known = this.projects.get(partition);
    if (known) return known;
    const session = this.ports.session(partition);
    const project: Project = {
      projectId,
      partition,
      session,
      permissions: new SitePermissionStore(
        this.ports.files,
        `corral-browser-${digest}.permissions.json`,
      ),
    };
    session.setPermissionRequestHandler((contents, permission, callback, details) =>
      this.onPermissionRequest(project, contents, permission, callback, details),
    );
    session.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
      const decision = permissionCheck(permission, details.mediaType);
      if (decision.kind !== 'stored') return decision.kind === 'grant';
      const origin = webOrigin(details.requestingUrl ?? requestingOrigin);
      return !!origin && project.permissions.get(origin, decision.permission) === true;
    });
    // Fullscreen is refused; telling the documents so makes requestFullscreen() reject at once.
    session.webRequest.onHeadersReceived(
      { urls: ['<all_urls>'], types: ['mainFrame', 'subFrame'] },
      (details, callback) =>
        callback({ responseHeaders: refuseFullscreen(details.responseHeaders) }),
    );
    // Device pickers (USB, HID, serial, Bluetooth per page) are refused without asking.
    session.setDevicePermissionHandler(() => false);
    session.on('select-hid-device', (event, _details, callback) => {
      event.preventDefault();
      callback();
    });
    session.on('select-usb-device', (event, _details, callback) => {
      event.preventDefault();
      callback();
    });
    session.on('select-serial-port', (event, _ports, _contents, callback) => {
      event.preventDefault();
      callback('');
    });
    session.on('will-download', (event, item, contents) =>
      this.onDownload(project, event, item, contents),
    );
    this.projects.set(partition, project);
    return project;
  }

  private tabsOf(project: Project) {
    return [...this.tabs.values()].filter((tab) => tab.project === project);
  }

  private tabOf(contents: WebContents | null | undefined) {
    const tab = contents ? this.byContents.get(contents.id) : undefined;
    return tab && tab.contents === contents ? tab : undefined;
  }

  private attach(tab: Tab, view: WebContentsView): WebContents {
    const contents = view.webContents;
    tab.view = view;
    tab.contents = contents;
    tab.focused = false;
    tab.gate = new NewWindowActivation(this.ports.now);
    this.byContents.set(contents.id, tab);
    view.setVisible(false);
    this.ports.surface()?.addChildView(view);
    this.wire(tab, contents);
    return contents;
  }

  /** Our own end of a page (never "the page closed itself"). */
  private dispose(tab: Tab) {
    const contents = tab.contents;
    this.detach(tab);
    this.endAsks(tab);
    this.endLogins(tab);
    this.cancelCapture(tab);
    tab.capture = null;
    tab.challenge = null;
    if (contents && !contents.isDestroyed()) contents.close();
  }

  private detach(tab: Tab) {
    tab.annotation.end();
    const view = tab.view;
    if (tab.contents) this.byContents.delete(tab.contents.id);
    tab.view = null;
    tab.contents = null;
    tab.frozen = false;
    tab.stillId = null;
    tab.stillEpoch++;
    if (view)
      try {
        this.ports.surface()?.removeChildView(view);
      } catch {
        // The view already left the window with its page.
      }
  }

  private forget(tab: Tab) {
    this.tabs.delete(tab.id);
    for (const other of this.tabs.values())
      if (other.openerTabId === tab.id) other.openerTabId = null;
    for (const [id, download] of this.transfers)
      if (!unfinished(download) && download.shownOn === null) this.transfers.delete(id);
  }

  private show(tab: Tab, url: string | null) {
    tab.page = 'live';
    tab.url = url;
    tab.failure = null;
    tab.blocked = null;
    this.apply(tab);
    this.emit(tab);
  }

  private visible(tab: Tab) {
    return !!tab.view && !!this.rects.get(tab.id) && !tab.frozen && tab.page === 'live';
  }

  private apply(tab: Tab) {
    const view = tab.view;
    if (!view) return;
    const rect = this.rects.get(tab.id);
    if (rect) view.setBounds(rect);
    view.setVisible(this.visible(tab));
    tab.annotation.layout();
  }

  private state(tab: Tab): BrowserTabState {
    const history = tab.contents?.isDestroyed() === false ? tab.contents.navigationHistory : null;
    let url = tab.url;
    if (url && tab.kind === 'preview' && tab.lease)
      try {
        url = observationUrl(url, tab.lease.target);
      } catch {
        url = null;
      }
    return {
      tabId: tab.id,
      kind: tab.kind,
      page: tab.page,
      url,
      title: tab.title,
      loading: tab.loading,
      canGoBack: history?.canGoBack() ?? false,
      canGoForward: history?.canGoForward() ?? false,
      failure: tab.failure,
      blocked: tab.blocked,
      pageFocused: tab.focused,
    };
  }

  private emit(tab: Tab) {
    if (this.tabs.get(tab.id) === tab) this.ports.send({ type: 'state', state: this.state(tab) });
  }

  private wire(tab: Tab, contents: WebContents) {
    const live = () => tab.contents === contents;
    contents.on('did-start-loading', () => {
      if (!live()) return;
      tab.loading = true;
      this.emit(tab);
    });
    contents.on('did-stop-loading', () => {
      if (!live()) return;
      tab.loading = false;
      if (tab.kind === 'page' && !tab.popup && tab.page === 'live' && tab.url === null) {
        tab.page = 'none';
        this.apply(tab);
      }
      this.emit(tab);
    });
    contents.on('did-start-navigation', (details) => {
      if (!live()) return;
      if (tab.capture) {
        tab.capture.revision++;
        this.cancelCapture(tab);
      }
      if (!details.isMainFrame || details.isSameDocument) return;
      // A move ends what the old page was asking for, unanswered and unremembered.
      this.endAsks(tab);
      this.endLogins(tab);
      if (tab.blocked && tab.lease && previewRequestAllowed(tab.lease.target, details.url)) {
        tab.blocked = null;
        this.emit(tab);
      }
    });
    contents.on('did-navigate', (_event, url) => {
      if (!live()) return;
      tab.challenge = null;
      tab.page = 'live';
      tab.failure = null;
      tab.url = url;
      tab.annotation.navigated('document', url);
      this.apply(tab);
      this.emit(tab);
    });
    // A page's leave check (beforeunload) is never asked: a typed address, a reload, back or
    // forward and the page's own moves go through, as closing does (Electron would cancel them).
    contents.on('will-prevent-unload', (event) => {
      if (live()) event.preventDefault();
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!live() || !isMainFrame) return;
      tab.url = url;
      tab.annotation.navigated('in-page', url);
      this.emit(tab);
    });
    contents.on('console-message', (event) => {
      if (live() && tab.kind === 'preview')
        tab.annotation.consoleMessage(event.level, event.message);
    });
    contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      if (!live() || !isMainFrame) return;
      const kind = loadFailure(code);
      if (!kind) return;
      const challenge = kind === 'certificate' && tab.challenge?.url === url ? tab.challenge : null;
      if (!challenge?.id) tab.challenge = null;
      tab.failure = {
        kind,
        code,
        certificate:
          kind === 'certificate'
            ? { reason: challenge?.reason ?? 'other', challengeId: challenge?.id ?? null }
            : null,
      };
      tab.page = 'failed';
      tab.url = url;
      tab.title = null; // the last title was the page before; the failed one has none
      this.apply(tab);
      this.emit(tab);
    });
    contents.on('page-title-updated', (_event, title) => {
      if (!live()) return;
      tab.title = title;
      this.emit(tab);
    });
    contents.on('focus', () => {
      if (live()) tab.focused = true;
    });
    contents.on('blur', () => {
      if (live()) tab.focused = false;
    });
    contents.on('render-process-gone', () => {
      if (!live()) return;
      this.endAsks(tab);
      this.endLogins(tab);
      tab.page = 'failed';
      tab.loading = false;
      tab.failure = { kind: 'crashed', code: 0, certificate: null };
      this.apply(tab);
      this.emit(tab);
    });
    contents.once('destroyed', () => {
      if (live()) this.closedItself(tab);
    });
    contents.on('before-input-event', (event, input) => this.onKey(tab, event, input));
    contents.on('input-event', (_event, input) => {
      if (live()) tab.gate.input(input.type);
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('select-bluetooth-device', (event, _devices, callback) => {
      event.preventDefault();
      callback('');
    });
    contents.setWindowOpenHandler((details) => this.onWindowOpen(tab, details));
    contents.on('context-menu', (_event, params) => {
      if (live()) this.onContextMenu(tab, contents, params);
    });
    if (tab.kind === 'preview') {
      // The lease rules (ABS-04): the page stays on the lease, and Corral says what it blocked.
      contents.on('will-navigate', (event) => {
        const lease = tab.lease;
        if (!live() || !lease || previewRequestAllowed(lease.target, event.url)) return;
        event.preventDefault();
        this.block(tab, event.url);
      });
      contents.on('will-redirect', (event) => {
        const lease = tab.lease;
        if (!live() || !lease || !event.isMainFrame) return;
        if (previewRequestAllowed(lease.target, event.url)) return;
        event.preventDefault();
        this.block(tab, event.url);
      });
      return;
    }
    contents.on('certificate-error', (event, url, error, certificate, callback, isMainFrame) =>
      this.onCertificateError(tab, live(), event, url, error, certificate, callback, isMainFrame),
    );
    contents.on('login', (event, details, authInfo, callback) =>
      this.onLogin(tab, live(), event, details, authInfo, callback),
    );
  }

  /** The page closed itself (window.close()); Electron cannot stop it. */
  private closedItself(tab: Tab) {
    this.detach(tab);
    this.endAsks(tab);
    this.endLogins(tab);
    this.cancelCapture(tab);
    tab.capture = null;
    tab.challenge = null;
    if (tab.popup) {
      // A page-opened tab goes; a download its page started shows on the opener's tab.
      const opener = tab.openerTabId ? this.tabs.get(tab.openerTabId) : undefined;
      for (const download of this.transfers.values())
        if (download.shownOn === tab.id) {
          download.shownOn = opener?.id ?? null;
          if (download.announced) this.sendDownload(download);
        }
      this.forget(tab);
      this.ports.send({ type: 'popup-closed', tabId: tab.id });
      return;
    }
    tab.lease?.stopWatch?.();
    if (tab.lease) tab.lease.stopWatch = null;
    tab.page = 'closed-itself';
    tab.loading = false;
    tab.failure = null;
    tab.blocked = null;
    this.emit(tab);
  }

  private onKey(tab: Tab, event: Event, input: Input) {
    if (tab.contents === null) return;
    const hit = pageKey(input, this.shortcuts, this.ports.mac);
    if (!hit) return;
    event.preventDefault();
    if (input.type !== 'keyDown') return;
    if (hit.action === 'zoom') {
      this.zoom(tab.id, hit.zoom);
      return;
    }
    if (input.isAutoRepeat) return;
    if (hit.action === 'reload') {
      this.reloadTab(tab);
      return;
    }
    this.ports.focusHost();
    if (hit.action === 'leave') this.ports.send({ type: 'leave', tabId: tab.id });
    else
      this.ports.send({
        type: 'shortcut',
        tabId: tab.id,
        id: hit.id,
        ...(hit.digit === undefined ? {} : { digit: hit.digit }),
      });
  }

  private reloadTab(tab: Tab) {
    const contents = tab.contents;
    if (!contents) return;
    const lease = tab.lease;
    if (!lease) {
      contents.reload();
      return;
    }
    // A preview reloads only while its lease still holds.
    void this.ports
      .resolveLease(lease.sessionId, lease.leaseId)
      .then((next) => {
        if (JSON.stringify(validatePreviewTarget(next)) !== JSON.stringify(lease.target))
          this.endLease(tab, lease);
        else if (tab.contents === contents && !contents.isDestroyed()) contents.reload();
      })
      .catch(() => this.endLease(tab, lease));
  }

  /** The page's right-click menu; an item picked once its page is gone does nothing. */
  private onContextMenu(tab: Tab, contents: WebContents, params: ContextMenuParams) {
    if (tab.capture?.cancel) return; // choosing an element: the right-click is the choice
    const groups = pageMenu(params, tab.kind === 'preview');
    if (!groups.length) return;
    const { linkURL, x, y } = params;
    const act = (item: PageMenuItem) => {
      if (tab.contents !== contents || contents.isDestroyed()) return;
      if (item === 'open-link') {
        const url = systemBrowserUrl(linkURL);
        const project = tab.project;
        if (url && project && this.tabs.get(tab.id) === tab)
          this.ports.send({ type: 'open-link', tabId: tab.id, projectId: project.projectId, url });
      } else if (item === 'copy-link') this.ports.copyText(linkURL);
      else if (item === 'copy-image') contents.copyImageAt(x, y);
      else if (item === 'cut') contents.cut();
      else if (item === 'copy') contents.copy();
      else if (item === 'paste') contents.paste();
      else contents.selectAll();
    };
    const korean = this.ports.korean();
    // Opened from the keyboard (Shift+F10, the menu key) or by touch: at the page's spot, the
    // focused element's; only a mouse-opened menu goes at the pointer.
    const rect = this.rects.get(tab.id);
    const at =
      params.menuSourceType !== 'mouse' && rect ? { x: rect.x + x, y: rect.y + y } : undefined;
    this.ports.popupMenu(
      groups.map((group) =>
        group.map((item) => ({ label: MENU_LABELS[item][korean ? 0 : 1], run: () => act(item) })),
      ),
      at,
    );
  }

  private onWindowOpen(tab: Tab, details: HandlerDetails): WindowOpenHandlerResponse {
    const lease = tab.lease;
    if (lease) {
      // A preview opens no window. The line offers an address outside the lease to the system
      // browser, so a same-lease or blank window is refused without it.
      const blank = /^about:blank(?:[?#]|$)/.test(details.url);
      if (!blank && !previewRequestAllowed(lease.target, details.url)) this.block(tab, details.url);
      return { action: 'deny' };
    }
    const project = tab.project;
    if (!project || (details.url !== 'about:blank' && !systemBrowserUrl(details.url)))
      return { action: 'deny' };
    if (!tab.gate.take()) return { action: 'deny' };
    return {
      action: 'allow',
      // The pop-up's page outlives its opener's tab (closing or unloading it).
      outlivesOpener: true,
      overrideBrowserWindowOptions: { show: false, webPreferences: { ...PAGE_PREFERENCES } },
      createWindow: (options) => this.adoptPopup(tab, project, options),
    };
  }

  private adoptPopup(opener: Tab, project: Project, options: BrowserWindowConstructorOptions) {
    const contents = (options as { webContents?: WebContents }).webContents;
    if (!contents) throw new Error('The new window has no page');
    const tab = this.newTab(this.ports.id(), 'page', project, null);
    tab.popup = true;
    tab.openerTabId = opener.id;
    tab.page = 'live';
    this.attach(tab, this.ports.createView({ contents }));
    this.ports.send({
      type: 'popup',
      tabId: tab.id,
      openerTabId: opener.id,
      projectId: project.projectId,
    });
    this.emit(tab);
    return contents;
  }

  private block(tab: Tab, url: string) {
    tab.blocked = { url: systemBrowserUrl(url) };
    this.emit(tab);
  }

  private watchLease(tab: Tab, lease: Lease) {
    lease.stopWatch?.();
    let checking = false;
    lease.stopWatch = this.ports.every(1000, () => {
      if (checking) return;
      checking = true;
      void this.ports
        .resolveLease(lease.sessionId, lease.leaseId)
        .then((next) => {
          if (JSON.stringify(validatePreviewTarget(next)) !== JSON.stringify(lease.target))
            this.endLease(tab, lease);
        })
        .catch(() => this.endLease(tab, lease))
        .finally(() => {
          checking = false;
        });
    });
  }

  /** "미리보기가 끝났습니다": the page unloads and its storage is cleared; the tab stays. */
  private endLease(tab: Tab, lease: Lease) {
    if (this.tabs.get(tab.id) !== tab || tab.lease !== lease || tab.page === 'ended') return;
    this.dispose(tab);
    this.endStorage(lease);
    tab.page = 'ended';
    tab.loading = false;
    tab.failure = null;
    tab.blocked = null;
    this.emit(tab);
  }

  private endStorage(lease: Lease) {
    lease.stopWatch?.();
    lease.stopWatch = null;
    void lease.session?.clearStorageData().catch(() => {});
    lease.session = null;
  }

  private cancelCapture(tab: Tab) {
    if (!tab.capture) return;
    tab.capture.captureEpoch++;
    tab.capture.cancel?.();
  }

  private onPermissionRequest(
    project: Project,
    contents: WebContents,
    permission: string,
    callback: (allow: boolean) => void,
    details: PermissionRequest & { mediaTypes?: string[] },
  ) {
    const tab = this.tabOf(contents);
    if (!tab || tab.project !== project) {
      callback(false);
      return;
    }
    const decision = permissionRequest(permission, details.mediaTypes);
    if (decision.kind !== 'ask') {
      callback(decision.kind === 'grant');
      return;
    }
    const origin = webOrigin(details.requestingUrl);
    if (!origin) {
      callback(false);
      return;
    }
    const known = this.known(project, origin, decision.permissions);
    if (known !== undefined) {
      callback(known);
      return;
    }
    const missing = decision.permissions.filter(
      (entry) => project.permissions.get(origin, entry) === undefined,
    );
    const waiting = { permissions: decision.permissions, done: callback };
    const same = tab.asks.find(
      (ask) =>
        ask.origin === origin &&
        ask.permissions.length === missing.length &&
        missing.every((entry) => ask.permissions.includes(entry)),
    );
    if (same) {
      same.waiting.push(waiting);
      return;
    }
    const ask: Ask = {
      requestId: this.ports.id(),
      origin,
      permissions: missing,
      waiting: [waiting],
    };
    tab.asks.push(ask);
    this.ports.send({
      type: 'permission',
      tabId: tab.id,
      requestId: ask.requestId,
      origin,
      permissions: missing,
    });
  }

  private known(project: Project, origin: string, permissions: SitePermission[]) {
    const answers = permissions.map((entry) => project.permissions.get(origin, entry));
    if (answers.includes(false)) return false;
    return answers.every((answer) => answer === true) ? true : undefined;
  }

  /** Answers every waiting request of a site whose permissions are now all known. */
  private settle(project: Project, origin: string) {
    for (const tab of this.tabsOf(project))
      for (const ask of [...tab.asks]) {
        if (ask.origin !== origin) continue;
        ask.waiting = ask.waiting.filter((waiting) => {
          const answer = this.known(project, origin, waiting.permissions);
          if (answer === undefined) return true;
          waiting.done(answer);
          return false;
        });
        if (ask.waiting.length) {
          // Still asking: the line names only what its requests still need, under its request.
          const needed = [...new Set(ask.waiting.flatMap((waiting) => waiting.permissions))].filter(
            (entry) => project.permissions.get(origin, entry) === undefined,
          );
          if (needed.join() !== ask.permissions.join()) {
            ask.permissions = needed;
            this.ports.send({
              type: 'permission',
              tabId: tab.id,
              requestId: ask.requestId,
              origin,
              permissions: needed,
            });
          }
          continue;
        }
        tab.asks = tab.asks.filter((entry) => entry !== ask);
        this.ports.send({ type: 'permission-ended', tabId: tab.id, requestId: ask.requestId });
      }
  }

  /** Refuses what is still asked, without remembering it. */
  private endAsks(tab: Tab) {
    const asks = tab.asks;
    tab.asks = [];
    for (const ask of asks) {
      for (const waiting of ask.waiting) waiting.done(false);
      this.ports.send({ type: 'permission-ended', tabId: tab.id, requestId: ask.requestId });
    }
  }

  private endLogins(tab: Tab) {
    const logins = [...tab.logins];
    tab.logins.clear();
    for (const [requestId, callback] of logins) {
      callback();
      this.ports.send({ type: 'login-ended', tabId: tab.id, requestId });
    }
  }

  private certificateKey(project: Project, hostname: string, fingerprint: string) {
    return `${project.partition}\n${hostname}\n${fingerprint}`;
  }

  /**
   * The only certificate-error listener (the app has none: two answers hung the main process).
   * It answers at once from the trusted set, or leaves Chromium's refusal to stand.
   */
  private onCertificateError(
    tab: Tab,
    live: boolean,
    event: Event,
    raw: string,
    error: string,
    certificate: Certificate,
    callback: (isTrusted: boolean) => void,
    isMainFrame: boolean,
  ) {
    if (!live || !isMainFrame || !tab.project) return;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return;
    }
    const loopback = url.protocol === 'https:' && isLoopbackHost(url.hostname);
    const key = this.certificateKey(tab.project, url.hostname, certificate.fingerprint);
    if (loopback && this.trusted.has(key)) {
      event.preventDefault();
      callback(true);
      return;
    }
    tab.challenge = {
      id: loopback ? this.ports.id() : null,
      url: raw,
      hostname: url.hostname,
      fingerprint: certificate.fingerprint,
      reason: certificateReason(error, certificate.issuerName === certificate.subjectName),
    };
  }

  private onLogin(
    tab: Tab,
    live: boolean,
    event: Event,
    details: AuthenticationResponseDetails,
    authInfo: AuthInfo,
    callback: (username?: string, password?: string) => void,
  ) {
    event.preventDefault();
    const origin = webOrigin(details.url);
    if (!live || authInfo.isProxy || !origin) {
      callback();
      return;
    }
    const requestId = this.ports.id();
    tab.logins.set(requestId, callback);
    this.ports.send({ type: 'login', tabId: tab.id, requestId, origin });
  }

  private onDownload(project: Project, event: Event, item: DownloadItem, contents: WebContents) {
    const tab = this.tabOf(contents);
    if (!tab || tab.project !== project) {
      event.preventDefault();
      return;
    }
    // No save path: the system dialog asks, with a title instead of the download's address.
    item.setSaveDialogOptions({ title: this.ports.korean() ? '다운로드 저장' : 'Save download' });
    const download: Download = {
      id: this.ports.id(),
      item,
      startedBy: tab.id,
      shownOn: tab.id,
      announced: false,
      state: 'progressing',
    };
    this.transfers.set(download.id, download);
    // 'interrupted' here is resumable (a dropped connection): the line says so, and goes back
    // to progressing if Chromium resumes it. Nothing else resumes it.
    item.on('updated', (_event, state) => {
      if (this.transfers.get(download.id) !== download) return;
      if (!unfinished(download)) return;
      if (!item.getSavePath()) return;
      download.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      download.announced = true;
      this.sendDownload(download);
    });
    item.once('done', (_event, state) => {
      if (this.transfers.get(download.id) !== download) return;
      download.state =
        state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted';
      if (!download.announced && state === 'completed' && item.getSavePath())
        download.announced = true;
      if (!download.announced) {
        this.transfers.delete(download.id);
        return;
      }
      this.sendDownload(download);
      if (download.shownOn === null || download.state !== 'completed')
        this.transfers.delete(download.id);
    });
  }

  private downloadState(download: Download): BrowserDownload {
    const item = download.item;
    return {
      downloadId: download.id,
      tabId: download.shownOn,
      name: basename(item.getSavePath()) || item.getFilename(),
      state: download.state,
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
    };
  }

  private sendDownload(download: Download) {
    this.ports.send({ type: 'download', download: this.downloadState(download) });
  }

  private async clearStorage(project: Project) {
    // clearStorageData leaves HTTP sign-ins in Chromium's auth cache (S5 spike).
    await Promise.all([
      project.session.clearStorageData(),
      project.session.clearCache(),
      project.session.clearAuthCache(),
    ]);
  }

  private leftPartitions(): string[] {
    try {
      const value = JSON.parse(this.ports.files.read(REMOVED) ?? '[]');
      return Array.isArray(value)
        ? value.filter(
            (name): name is string =>
              typeof name === 'string' && /^persist:corral-browser-[0-9a-f]{32}$/.test(name),
          )
        : [];
    } catch {
      return [];
    }
  }

  /** Deletes the folders of projects removed earlier, before any session opens them. */
  private removeLeftPartitions() {
    const left = this.leftPartitions().filter((partition) => {
      try {
        this.ports.removePartition(partition);
        return false;
      } catch {
        return true;
      }
    });
    if (left.length) this.ports.files.write(REMOVED, JSON.stringify(left));
    else this.ports.files.remove(REMOVED);
  }
}
