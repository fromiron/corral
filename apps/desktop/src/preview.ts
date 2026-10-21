import { BrowserWindow, session, WebContentsView } from 'electron';
import { previewRequestAllowed, validatePreviewTarget } from './preview-policy.ts';

/** Native preview surfaces have no preload, app cookie jar, or renderer IPC capability. */
export class DesktopPreviews {
  private windows = new Map<string, BrowserWindow>();
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
    const target = validatePreviewTarget(await this.resolveTarget(sessionId, leaseId));
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
