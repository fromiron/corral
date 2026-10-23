import {
  BrowserWindow,
  type ContextMenuParams,
  type Event,
  type Input,
  session,
  type WebContentsConsoleMessageEventParams,
  WebContentsView,
} from 'electron';
import {
  observationScript,
  observationUrl,
  type SelectedPreviewElement,
  safeObservationText,
} from './preview-observation.ts';
import {
  type DesktopPreviewTarget,
  previewRequestAllowed,
  validatePreviewTarget,
} from './preview-policy.ts';

interface PreviewCapture {
  sessionId: string;
  leaseId: string;
  capturedAt: string;
  url: string;
  pageRevision: number;
  sourceRevision: null;
  element: SelectedPreviewElement['element'];
  console: { level: string; message: string }[];
  screenshot: { mime: 'image/png'; data: string; width: number; height: number } | null;
}
class PreviewCaptureFailure extends Error {}

/** Native preview surfaces have no preload, app cookie jar, or renderer IPC capability. */
export class DesktopPreviews {
  private windows = new Map<string, BrowserWindow>();
  private views = new Map<
    string,
    {
      view: WebContentsView;
      target: DesktopPreviewTarget;
      revision: number;
      captureEpoch: number;
      cancel?: () => void;
    }
  >();
  private generation = 0;
  private epochs = new Map<string, number>();
  private resolveTarget: (sessionId: string, leaseId: string) => Promise<unknown>;
  constructor(resolveTarget: (sessionId: string, leaseId: string) => Promise<unknown>) {
    this.resolveTarget = resolveTarget;
  }

  async open(sessionId: string, leaseId: string) {
    const generation = this.generation;
    if (
      !/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(sessionId) ||
      !/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(leaseId)
    )
      throw new Error('Invalid preview identity');
    const key = `${sessionId}/${leaseId}`;
    const epoch = this.epochs.get(key) ?? 0;
    const current = this.windows.get(key);
    if (current && !current.isDestroyed()) {
      current.show();
      current.focus();
      return;
    }
    const target = structuredClone(
      validatePreviewTarget(await this.resolveTarget(sessionId, leaseId)),
    );
    if (generation !== this.generation || epoch !== (this.epochs.get(key) ?? 0))
      throw new Error('Preview was closed');
    const opened = this.windows.get(key);
    if (opened && !opened.isDestroyed()) {
      opened.show();
      opened.focus();
      return;
    }
    const partition = session.fromPartition(`preview-${crypto.randomUUID()}`, { cache: false });
    partition.setPermissionCheckHandler(() => false);
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    partition.on('will-download', (event) => event.preventDefault());
    partition.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !previewRequestAllowed(target, details.url, details.resourceType) });
    });
    partition.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, ...target.headers } });
    });
    partition.webRequest.onHeadersReceived((details, callback) => {
      // The proxy's own CSP may be stricter. Append a policy, never relax that policy.
      const headers = { ...details.responseHeaders };
      const csp = `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src ${target.origin} ${(target.webSocketOrigins ?? []).join(' ')}; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'`;
      const existing = Object.keys(headers).find(
        (name) => name.toLowerCase() === 'content-security-policy',
      );
      headers[existing ?? 'Content-Security-Policy'] = [
        ...(existing ? (headers[existing] ?? []) : []),
        csp,
      ];
      callback({ responseHeaders: headers });
    });
    const window = new BrowserWindow({
      title: 'Corral Preview',
      width: 1100,
      height: 800,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const view = new WebContentsView({
      webPreferences: {
        session: partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    const surface = { view, target, revision: 0, captureEpoch: 0 };
    this.views.set(key, surface);
    view.webContents.on('did-start-navigation', () => {
      surface.revision++;
      this.cancelCapture(sessionId, leaseId);
    });
    view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    window.contentView.addChildView(view);
    const resize = () => {
      const [width = 0, height = 0] = window.getContentSize();
      view.setBounds({ x: 0, y: 0, width, height });
    };
    resize();
    window.on('resize', resize);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-attach-webview', (event) => event.preventDefault());
    view.webContents.on('will-navigate', (event, url) => {
      if (!previewRequestAllowed(target, url)) event.preventDefault();
    });
    view.webContents.on('before-input-event', (event, input) => {
      if ((input.control || input.meta) && input.key.toLowerCase() === 'r') {
        event.preventDefault();
        void this.resolveTarget(sessionId, leaseId)
          .then((next) => {
            if (JSON.stringify(validatePreviewTarget(next)) !== JSON.stringify(target)) {
              window.close();
              return;
            }
            if (!view.webContents.isDestroyed()) view.webContents.reload();
          })
          .catch(() => window.close());
      }
    });
    this.windows.set(key, window);
    let checking = false;
    const watch = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.resolveTarget(sessionId, leaseId)
        .then((next) => {
          const active = validatePreviewTarget(next);
          if (JSON.stringify(active) !== JSON.stringify(target)) window.close();
        })
        .catch(() => {
          if (!window.isDestroyed()) window.close();
        })
        .finally(() => {
          checking = false;
        });
    }, 1000);
    watch.unref();
    window.on('closed', () => {
      clearInterval(watch);
      this.cancelCapture(sessionId, leaseId);
      this.views.delete(key);
      this.windows.delete(key);
      if (!view.webContents.isDestroyed()) view.webContents.close();
      void partition.clearStorageData().catch(() => {});
    });
    try {
      await view.webContents.loadURL(target.url);
      window.show();
    } catch {
      window.close();
      throw new Error('Preview could not be opened');
    }
  }

  async capture(sessionId: string, leaseId: string, raw: unknown): Promise<PreviewCapture> {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.keys(raw).some((key) => key !== 'screenshot' && key !== 'console') ||
      typeof (raw as { screenshot?: unknown }).screenshot !== 'boolean' ||
      typeof (raw as { console?: unknown }).console !== 'boolean'
    )
      throw new Error('Invalid preview capture options');
    const options = raw as { screenshot: boolean; console: boolean };
    const key = `${sessionId}/${leaseId}`;
    const surface = this.views.get(key),
      window = this.windows.get(key);
    if (!surface || !window || window.isDestroyed()) throw new Error('Open this preview first');
    this.cancelCapture(sessionId, leaseId);
    const epoch = surface.captureEpoch,
      revision = surface.revision;
    const contents = surface.view.webContents,
      url = contents.getURL();
    const current = () => {
      if (
        this.views.get(key) !== surface ||
        contents.isDestroyed() ||
        window.isDestroyed() ||
        surface.captureEpoch !== epoch ||
        surface.revision !== revision ||
        contents.getURL() !== url
      )
        throw new Error('Preview capture was cancelled or the page changed');
      if (!previewRequestAllowed(surface.target, url)) throw new Error('Preview page changed');
    };
    const validate = async () => {
      const target = validatePreviewTarget(await this.resolveTarget(sessionId, leaseId));
      current();
      if (JSON.stringify(target) !== JSON.stringify(surface.target))
        throw new Error('Preview lease changed');
    };
    await validate();
    return new Promise<PreviewCapture>((resolve, reject) => {
      let settled = false,
        selecting = false;
      const messages: PreviewCapture['console'] = [];
      const finish = (error?: Error, result?: PreviewCapture) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        contents.off('context-menu', choose);
        contents.off('before-input-event', onKey);
        contents.off('console-message', log);
        contents.off('destroyed', cancel);
        contents.off('render-process-gone', cancel);
        if (surface.cancel === cancel) surface.cancel = undefined;
        if (error) reject(error);
        else if (result) resolve(result);
      };
      const cancel = () => finish(new Error('Preview capture was cancelled'));
      const onKey = (event: Event, input: Input) => {
        if (input.key === 'Escape') {
          event.preventDefault();
          this.cancelCapture(sessionId, leaseId);
        }
      };
      const log = (event: Event<WebContentsConsoleMessageEventParams>) => {
        if (options.console && messages.length < 20 && typeof event.message === 'string')
          messages.push({
            level: String(event.level).slice(0, 20),
            message: safeObservationText(event.message, surface.target).slice(0, 1000),
          });
      };
      const choose = (event: Event, params: ContextMenuParams) => {
        if (selecting || settled) return;
        event.preventDefault();
        if (
          params.frame !== contents.mainFrame ||
          !['mouse', 'keyboard', 'touch', 'longPress'].includes(params.menuSourceType)
        ) {
          finish(new Error('Select an element in this preview page'));
          return;
        }
        selecting = true;
        void (async () => {
          current();
          const selected: SelectedPreviewElement | null =
            await contents.executeJavaScriptInIsolatedWorld(1001, [
              { code: observationScript(params.x, params.y, params.menuSourceType === 'keyboard') },
            ]);
          current();
          if (settled) return;
          if (!selected)
            throw new PreviewCaptureFailure('Select a visible element rather than the whole page');
          const element = selected.element;
          element.selector = safeObservationText(element.selector, surface.target).slice(0, 500);
          element.text = safeObservationText(element.text, surface.target).slice(0, 4000);
          element.role =
            element.role === null
              ? null
              : safeObservationText(element.role, surface.target).slice(0, 120);
          for (const [name, value] of Object.entries(element.styles))
            element.styles[name] = safeObservationText(value, surface.target).slice(0, 200);
          let screenshot: PreviewCapture['screenshot'] = null;
          if (options.screenshot) {
            if (!selected.screenshotSafe)
              throw new PreviewCaptureFailure(
                'Screenshots containing input fields are not captured',
              );
            const bounds = element.bounds;
            const rect = {
              x: Math.ceil(bounds.x),
              y: Math.ceil(bounds.y),
              width: Math.floor(bounds.width),
              height: Math.floor(bounds.height),
            };
            if (rect.width < 1 || rect.height < 1 || rect.width > 2048 || rect.height > 2048)
              throw new PreviewCaptureFailure('Select an area no larger than 2048 pixels');
            const image = await contents.capturePage(rect);
            current();
            if (settled) return;
            const size = image.getSize(1);
            const bytes = image.toPNG({ scaleFactor: 1 });
            if (
              !size.width ||
              !size.height ||
              size.width > 2048 ||
              size.height > 2048 ||
              bytes.length > 1024 * 1024
            )
              throw new PreviewCaptureFailure('The selected screenshot exceeds the image limit');
            screenshot = { mime: 'image/png', data: bytes.toString('base64'), ...size };
          }
          await validate();
          if (settled) return;
          finish(undefined, {
            sessionId,
            leaseId,
            capturedAt: new Date().toISOString(),
            url: observationUrl(url, surface.target),
            pageRevision: revision,
            sourceRevision: null,
            element,
            console: messages,
            screenshot,
          });
        })().catch((error) =>
          finish(
            error instanceof PreviewCaptureFailure
              ? error
              : new Error(
                  'Preview selection could not be captured; the page or lease may have changed',
                ),
          ),
        );
      };
      const deadline = setTimeout(() => {
        this.cancelCapture(sessionId, leaseId);
      }, 30000);
      surface.cancel = cancel;
      contents.on('context-menu', choose);
      contents.on('before-input-event', onKey);
      contents.on('console-message', log);
      contents.once('destroyed', cancel);
      contents.once('render-process-gone', cancel);
      window.show();
      window.focus();
      contents.focus();
    });
  }

  cancelCapture(sessionId: string, leaseId: string) {
    const surface = this.views.get(`${sessionId}/${leaseId}`);
    if (surface) {
      surface.captureEpoch++;
      surface.cancel?.();
    }
  }

  closeAll() {
    this.generation++;
    this.epochs.clear();
    for (const window of this.windows.values()) if (!window.isDestroyed()) window.close();
  }

  close(sessionId: string, leaseId: string) {
    const key = `${sessionId}/${leaseId}`;
    this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
    const window = this.windows.get(key);
    if (window && !window.isDestroyed()) window.close();
  }
}
