// The browser tab's bridge between the studio and the desktop main process
// (docs/specs/features/browser-tab.md). `window.corralDesktop.browser` (preload.cjs) has this
// shape; main validates every argument again. Types only: the studio may import them.
import type {
  CertificateReason,
  LoadFailureKind,
  PageChord,
  SitePermission,
} from './browser-policy.ts';
import type { PreviewCapture } from './preview-capture.ts';

export type { CertificateReason, LoadFailureKind, PageChord, SitePermission };

/** A rectangle of the tab body in the host page's CSS pixels; main applies the app zoom. */
export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * What the page area shows. `live` is a page view (also while it loads); the others are drawn
 * by the host in the page area, where main keeps the view hidden.
 */
export type BrowserPage = 'none' | 'live' | 'failed' | 'closed-itself' | 'ended';

export interface BrowserFailure {
  kind: LoadFailureKind | 'crashed';
  /** Chromium's net error code; 0 for a crash. */
  code: number;
  /** Set for a main-frame certificate error. */
  certificate: {
    reason: CertificateReason;
    /** Present only for localhost, 127.0.0.1 and ::1: "그래도 열기" sends it back. */
    challengeId: string | null;
  } | null;
}

export interface BrowserTabState {
  tabId: string;
  kind: 'page' | 'preview';
  page: BrowserPage;
  /**
   * The current or last address. An ordinary page's in full; a preview page's as origin and
   * path, without the lease's private path or query.
   */
  url: string | null;
  title: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  failure: BrowserFailure | null;
  /** A preview page's latest blocked move off the lease; `url` is null when not http(s). */
  blocked: { url: string | null } | null;
  /** Whether the page had keyboard focus (kept as it was when the page closed itself). */
  pageFocused: boolean;
}

export interface BrowserDownload {
  downloadId: string;
  /** The tab whose head shows it; null when that tab is gone (it carries on without a line). */
  tabId: string | null;
  name: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  receivedBytes: number;
  totalBytes: number;
}

export type BrowserEvent =
  | { type: 'state'; state: BrowserTabState }
  /** A page opened a new window: add this tab at the strip's end and select it. */
  | { type: 'popup'; tabId: string; openerTabId: string; projectId: string }
  /** A page-opened tab's page closed (itself or by its opener): remove the tab. */
  | { type: 'popup-closed'; tabId: string }
  /** Shift+Escape in the page: focus is back in the host; move it to the address field. */
  | { type: 'leave'; tabId: string }
  /** An app shortcut pressed in the page; focus is back in the host. */
  | { type: 'shortcut'; tabId: string; id: string; digit?: number }
  | {
      type: 'permission';
      tabId: string;
      requestId: string;
      /** The requesting site's origin. */
      origin: string;
      permissions: SitePermission[];
    }
  /** The ask is over (answered, or refused because the tab closed or moved on): drop its line. */
  | { type: 'permission-ended'; tabId: string; requestId: string }
  | { type: 'login'; tabId: string; requestId: string; origin: string }
  | { type: 'login-ended'; tabId: string; requestId: string }
  | { type: 'download'; download: BrowserDownload };

export interface BrowserStill {
  stillId: string;
  /** PNG; memory only, never stored or sent anywhere else. */
  dataUrl: string;
  width: number;
  height: number;
}

export interface BrowserBridge {
  /** Opens an address in an ordinary page tab, making its view on first use. */
  navigate(
    tabId: string,
    projectId: string,
    address: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'unsupported-address' }>;
  /** Opens a ready preview lease in a preview tab (a fresh in-memory storage per tab). */
  openPreview(tabId: string, sessionId: string, leaseId: string): Promise<void>;
  /** Where the tab body is; null hides the view. */
  place(tabId: string, rect: BrowserRect | null): Promise<void>;
  /** The person closed the tab: its page unloads, its own downloads are cancelled. */
  close(tabId: string): Promise<void>;
  /** The conversation was left: the page unloads, downloads carry on. */
  unload(tabId: string): Promise<void>;
  reload(tabId: string): Promise<void>;
  stop(tabId: string): Promise<void>;
  back(tabId: string): Promise<void>;
  forward(tabId: string): Promise<void>;
  /** "다시 열기" after the page closed itself: the last address in a new page. */
  reopen(tabId: string): Promise<void>;
  zoom(tabId: string, zoom: 'in' | 'out' | 'reset'): Promise<void>;
  /** Moves keyboard focus into the page. */
  focus(tabId: string): Promise<void>;
  /** Step 1 of the still-image swap: a picture of the live view, which stays live. */
  still(tabId: string): Promise<BrowserStill | null>;
  /** Step 2, once the picture is painted: hides the live view. False if a newer step won. */
  freeze(tabId: string, stillId: string): Promise<boolean>;
  /** Shows the live view again. */
  thaw(tabId: string): Promise<void>;
  answerPermission(tabId: string, requestId: string, allow: boolean): Promise<void>;
  sitePermissions(
    projectId: string,
    origin: string,
  ): Promise<{ permission: SitePermission; allow: boolean }[]>;
  forgetPermission(projectId: string, origin: string, permission: SitePermission): Promise<void>;
  /** Null cancels: the site's 401 page shows. Nothing is stored. */
  answerLogin(
    tabId: string,
    requestId: string,
    credentials: { username: string; password: string } | null,
  ): Promise<void>;
  /** "그래도 열기" for a loopback certificate; false when that error is no longer current. */
  proceedCertificate(tabId: string, challengeId: string): Promise<boolean>;
  downloads(tabId: string): Promise<BrowserDownload[]>;
  cancelDownload(downloadId: string): Promise<void>;
  showDownload(downloadId: string): Promise<void>;
  /** Opens the preview tab's latest blocked address in the system browser. */
  openBlocked(tabId: string): Promise<boolean>;
  /** Clears the project's browser storage, sign-ins and permission answers; reloads its pages. */
  clearProjectData(projectId: string): Promise<void>;
  /** The project was removed from Corral: its tabs close and its browser storage goes. */
  removeProject(projectId: string): Promise<void>;
  /** The app shortcuts (with their rebindings) to take from pages. */
  setShortcuts(chords: PageChord[]): Promise<void>;
  /** Element capture on a preview tab (workbench.md "미리보기 요소 피드백"). */
  capturePreview(
    tabId: string,
    options: { screenshot: boolean; console: boolean },
  ): Promise<PreviewCapture>;
  cancelPreviewCapture(tabId: string): Promise<void>;
  onEvent(callback: (event: BrowserEvent) => void): () => void;
}
