import { BrowserWindow, session, WebContentsView } from 'electron';
import {
  capturePreviewSelection,
  type PreviewCapture,
  type PreviewCaptureSurface,
  previewCaptureOptions,
} from './preview-capture.ts';
import { previewRequestAllowed, validatePreviewTarget } from './preview-policy.ts';
import { applyLeaseRules } from './preview-session.ts';

/** Native preview surfaces have no preload, app cookie jar, or renderer IPC capability. */
export class DesktopPreviews {
  private windows = new Map<string, BrowserWindow>();
  private views = new Map<string, PreviewCaptureSurface>();
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
    applyLeaseRules(partition, target);
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
    const surface: PreviewCaptureSurface = {
      contents: view.webContents,
      target,
      revision: 0,
      captureEpoch: 0,
    };
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
    const options = previewCaptureOptions(raw);
    const key = `${sessionId}/${leaseId}`;
    const surface = this.views.get(key),
      window = this.windows.get(key);
    if (!surface || !window || window.isDestroyed()) throw new Error('Open this preview first');
    this.cancelCapture(sessionId, leaseId);
    return capturePreviewSelection({
      sessionId,
      leaseId,
      surface,
      options,
      alive: () => this.views.get(key) === surface && !window.isDestroyed(),
      resolveTarget: () => this.resolveTarget(sessionId, leaseId),
      cancel: () => this.cancelCapture(sessionId, leaseId),
      reveal: () => {
        window.show();
        window.focus();
      },
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
