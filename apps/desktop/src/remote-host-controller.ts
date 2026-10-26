import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type MenuItemConstructorOptions,
  session,
} from 'electron';
import { installStudioMicrophone } from './microphone.ts';
import { RemoteHostPreviews } from './remote-host-preview.ts';
import {
  connectRemoteHost,
  parseRemoteHostImport,
  type RemoteHostConnection,
  RemoteHostRegistry,
  remotePartition,
  remoteRequestAllowed,
} from './remote-hosts.ts';

const MANAGER_URL = 'corral://hosts/';
const CHANNEL = 'desktop:remote-hosts';
type OpenHost = {
  abort: AbortController;
  connection?: RemoteHostConnection;
  window?: BrowserWindow;
  stopped: boolean;
  pending: Promise<void>;
  previews?: RemoteHostPreviews;
};

/** Native entry point: File → Remote hosts. Remote pages never receive local desktop IPC. */
export class RemoteHostController {
  private readonly registry: RemoteHostRegistry;
  private manager: BrowserWindow | null = null;
  private readonly open = new Map<string, OpenHost>();
  private disposed = false;
  private notice = '';
  private readonly parent: () => BrowserWindow | null;
  private readonly korean: () => boolean;

  constructor(parent: () => BrowserWindow | null, korean: () => boolean = () => false) {
    this.parent = parent;
    this.korean = korean;
    this.registry = new RemoteHostRegistry(join(app.getPath('userData'), 'remote-hosts.json'));
    const local = session.fromPartition('persist:corral-host-manager');
    local.protocol.handle('corral', (request) => {
      const url = new URL(request.url);
      const name = (
        {
          '/': 'remote-host.html',
          '/remote-host.css': 'remote-host.css',
          '/remote-host.js': 'remote-host.js',
        } as Record<string, string>
      )[url.pathname];
      if (url.hostname !== 'hosts' || !name) return new Response('', { status: 404 });
      return new Response(readFileSync(join(import.meta.dirname, name)), {
        headers: {
          'content-type': name.endsWith('.js')
            ? 'text/javascript'
            : name.endsWith('.css')
              ? 'text/css'
              : 'text/html',
        },
      });
    });
    local.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
    local.setPermissionCheckHandler(() => false);
    local.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !details.url.startsWith(MANAGER_URL) }),
    );
    ipcMain.handle(CHANNEL, async (event, action: unknown, value: unknown) => {
      if (
        !this.manager ||
        event.sender !== this.manager.webContents ||
        event.senderFrame !== this.manager.webContents.mainFrame ||
        event.senderFrame.url !== MANAGER_URL
      )
        throw new Error('Untrusted remote host request.');
      try {
        if (this.disposed) throw new Error('The app is closing.');
        if (action === 'list')
          return {
            notice: this.notice,
            hosts: this.registry.list().map((host) => ({
              ...host,
              connected: this.open.get(host.id)?.connection?.connected ?? false,
            })),
          };
        this.notice = '';
        if (action === 'register') {
          const input = parseRemoteHostImport(value);
          const host = this.registry.register(input);
          await this.connect(host.id, input.bootstrapUrl);
        } else if (action === 'connect') await this.connect(String(value));
        else if (action === 'disconnect') await this.stop(String(value));
        else if (action === 'remove') {
          await this.stop(String(value));
          const host = this.registry.list().find((item) => item.id === value);
          if (host) {
            const isolated = session.fromPartition(remotePartition(host));
            await isolated.clearStorageData();
            await isolated.clearCache();
          }
          this.registry.remove(String(value));
        } else throw new Error('Unknown host action.');
        return { ok: true };
      } catch (error) {
        // Only our bounded messages cross this boundary; network URLs/tokens never do.
        const message =
          error instanceof Error && error.message.length < 350
            ? error.message
            : 'Could not connect to this host.';
        return { error: message };
      }
    });
    ipcMain.handle(
      'desktop:remote-preview',
      async (event, sessionId: unknown, leaseId: unknown) => {
        const state = [...this.open.values()].find(
          (entry) => entry.window?.webContents === event.sender,
        );
        if (
          !state?.window ||
          state.stopped ||
          !state.connection?.connected ||
          event.senderFrame !== state.window.webContents.mainFrame ||
          new URL(event.senderFrame.url).origin !== state.connection.origin ||
          typeof sessionId !== 'string' ||
          typeof leaseId !== 'string'
        )
          throw new Error('Untrusted remote preview request.');
        await state.previews?.open(sessionId, leaseId);
      },
    );
  }

  menuItem(): MenuItemConstructorOptions {
    return {
      label: app.getLocale().startsWith('ko') ? '원격 호스트…' : 'Remote hosts…',
      click: () => this.show(),
    };
  }

  show() {
    if (this.disposed) return;
    if (this.manager) {
      this.manager.show();
      this.manager.focus();
      return;
    }
    this.manager = new BrowserWindow({
      width: 660,
      height: 720,
      minWidth: 480,
      minHeight: 540,
      parent: this.parent() ?? undefined,
      autoHideMenuBar: true,
      title: 'Corral · Remote hosts',
      backgroundColor: '#151515',
      webPreferences: {
        partition: 'persist:corral-host-manager',
        preload: join(import.meta.dirname, 'remote-host-preload.cjs'),
        // The app's language for this window's text; the page reads nothing else from it.
        additionalArguments: [`--corral-lang=${this.korean() ? 'ko' : 'en'}`],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.manager.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.manager.webContents.on('will-navigate', (event, url) => {
      if (url !== MANAGER_URL) event.preventDefault();
    });
    this.manager.webContents.on('will-attach-webview', (event) => event.preventDefault());
    this.manager.webContents.on('will-prevent-unload', (event) => {
      if (
        this.manager &&
        dialog.showMessageBoxSync(this.manager, {
          type: 'question',
          message: app.getLocale().startsWith('ko')
            ? '입력한 연결 정보를 버릴까요?'
            : 'Discard the entered connection details?',
          buttons: app.getLocale().startsWith('ko')
            ? ['계속 편집', '버리기']
            : ['Keep editing', 'Discard'],
          defaultId: 0,
          cancelId: 0,
        }) === 1
      )
        event.preventDefault();
    });
    this.manager.on('closed', () => {
      this.manager = null;
    });
    void this.manager.loadURL(MANAGER_URL);
  }

  private async connect(id: string, bootstrapUrl?: string) {
    const existing = this.open.get(id);
    if (existing) {
      await existing.pending;
      existing.window?.show();
      existing.window?.focus();
      return;
    }
    const host = this.registry.list().find((item) => item.id === id);
    if (!host) throw new Error('This host is no longer registered.');
    const sshExecutable =
      process.platform === 'win32'
        ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
        : ['/usr/bin/ssh', '/bin/ssh'].find(existsSync);
    const sshConfig = join(homedir(), '.ssh', 'config');
    if (!sshExecutable || !existsSync(sshExecutable) || !existsSync(sshConfig))
      throw new Error('Install OpenSSH and add this host to your ~/.ssh/config first.');
    const remoteSession = session.fromPartition(remotePartition(host));
    const origin = `http://127.0.0.1:${host.port}`;
    const state: OpenHost = {
      abort: new AbortController(),
      stopped: false,
      pending: Promise.resolve(),
    };
    this.open.set(id, state);
    // Secondary loopback endpoints require a live lease from this remote host and an owned tunnel.
    remoteSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed = remoteRequestAllowed(
        details.url,
        origin,
        !state.stopped && (state.connection?.connected ?? false),
        details.resourceType,
      );
      if (allowed) return callback({ cancel: false });
      const current = state.window?.webContents.getURL() ?? '';
      const sessionId = /^\/sessions\/([^/]+)/.exec(new URL(current || origin).pathname)?.[1];
      if (
        !state.stopped &&
        state.connection?.connected &&
        state.previews &&
        sessionId &&
        details.url.startsWith('http://127.0.0.2:') &&
        details.webContentsId === state.window?.webContents.id
      ) {
        void state.previews.allowPublic(decodeURIComponent(sessionId), details.url).then(
          (approved) => callback({ cancel: !approved }),
          () => callback({ cancel: true }),
        );
      } else callback({ cancel: true });
    });
    installStudioMicrophone(remoteSession, () => ({
      window: state.window,
      origin: !state.stopped && state.connection?.connected ? origin : null,
    }));
    state.pending = (async () => {
      try {
        state.connection = await connectRemoteHost(host, {
          sshExecutable,
          sshConfig,
          signal: state.abort.signal,
          pinIdentity: (fingerprint) => this.registry.pinTarget(host.id, fingerprint),
          onDisconnect: () => {
            const intentional = state.stopped;
            state.stopped = true;
            state.abort.abort();
            void state.previews?.close();
            state.window?.destroy();
            if (this.open.get(id) === state) this.open.delete(id);
            if (!intentional && !this.disposed) {
              this.notice = app.getLocale().startsWith('ko')
                ? '원격 연결이 끊겼습니다. 원격 실행은 계속될 수 있습니다. 다시 연결한 뒤 실행 상태를 확인하세요.'
                : 'Connection lost. Remote work may still be running. Reconnect and check its state before resubmitting an uncertain command.';
              this.show();
            }
          },
        });
        if (state.stopped || this.disposed) {
          await state.connection.close();
          return;
        }
        state.previews = new RemoteHostPreviews({
          host,
          session: remoteSession,
          sshExecutable,
          sshConfig,
          signal: state.abort.signal,
          pinIdentity: (fingerprint) => this.registry.pinTarget(host.id, fingerprint),
        });
        const healthResponse = await remoteSession.fetch(`${origin}/api/v1/health`, {
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        });
        const health = healthResponse.ok ? await healthResponse.json() : null;
        if (
          health?.ok !== true ||
          health.schemaVersion !== '0.1' ||
          typeof health.backendSessionId !== 'string'
        )
          throw new Error('This endpoint is not a supported Corral server (schema 0.1).');
        if (bootstrapUrl) {
          const response = await remoteSession.fetch(`${origin}/api/v1/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: origin },
            body: JSON.stringify({ token: new URL(bootstrapUrl).hash.slice('#bootstrap='.length) }),
            signal: AbortSignal.timeout(10000),
            redirect: 'error',
          });
          if (response.status !== 204)
            throw new Error(
              'The bootstrap link is invalid or expired. Paste the current server link.',
            );
        }
        const authenticated = await remoteSession.fetch(`${origin}/api/v1/session`, {
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        });
        if (!authenticated.ok)
          throw new Error(
            "This remote session expired. Paste the current server's bootstrap link to reconnect.",
          );
        if (state.stopped || this.disposed) {
          await state.connection.close();
          return;
        }
        const title = `Corral · ${host.name} (SSH)`;
        const remoteWindow = new BrowserWindow({
          width: 1440,
          height: 900,
          minWidth: 480,
          minHeight: 540,
          title,
          backgroundColor: '#151515',
          webPreferences: {
            partition: remotePartition(host),
            preload: join(import.meta.dirname, 'remote-host-content-preload.cjs'),
            additionalArguments: [`--corral-host-id=${host.id}`],
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
          },
        });
        state.window = remoteWindow;
        remoteWindow.setMenu(null);
        remoteWindow.webContents.on('page-title-updated', (event) => {
          event.preventDefault();
          remoteWindow.setTitle(title);
        });
        remoteWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        remoteWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
        remoteWindow.webContents.on('will-navigate', (event, url) => {
          if (!remoteRequestAllowed(url, origin, !state.stopped)) event.preventDefault();
        });
        remoteWindow.on('closed', () => {
          state.window = undefined;
          void this.stop(id);
        });
        try {
          await remoteWindow.loadURL(`${origin}/`);
        } catch {
          throw new Error('Remote Corral did not load. Check its server and bootstrap link.');
        }
      } catch (error) {
        state.stopped = true;
        await state.previews?.close();
        state.window?.destroy();
        await state.connection?.close();
        if (this.open.get(id) === state) this.open.delete(id);
        throw error;
      }
    })();
    await state.pending;
  }

  private async stop(id: string) {
    const state = this.open.get(id);
    if (!state) return;
    state.stopped = true;
    state.abort.abort();
    await state.previews?.close();
    state.window?.destroy();
    await state.pending.catch(() => {});
    await state.connection?.close();
    if (this.open.get(id) === state) this.open.delete(id);
  }

  async dispose() {
    this.disposed = true;
    await Promise.all([...this.open.keys()].map((id) => this.stop(id)));
    this.manager?.destroy();
    ipcMain.removeHandler(CHANNEL);
    ipcMain.removeHandler('desktop:remote-preview');
    session.fromPartition('persist:corral-host-manager').protocol.unhandle('corral');
  }
}
