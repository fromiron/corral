import { type ChildProcess, fork } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  session as electronSession,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  Notification,
  nativeTheme,
  protocol,
  screen,
  shell,
} from 'electron';
import {
  type DesktopCommand,
  externalUrl,
  localRoute,
  notificationText,
  recentWorkspaces,
  themeColors,
  trustedSender,
} from './security.ts';

app.setName('Corral');
const dataArg = process.argv.find((arg) => arg.startsWith('--data-dir='))?.slice(11);
if (dataArg && isAbsolute(dataArg)) app.setPath('userData', dataArg);
protocol.registerSchemesAsPrivileged([
  { scheme: 'corral', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const STARTUP = 'corral://startup/';
const runtime = app.isPackaged
  ? join(process.resourcesPath, 'runtime')
  : resolve(import.meta.dirname, '../staging');
const stateFile = join(app.getPath('userData'), 'desktop.json');
interface SavedState {
  workspace: string;
  port: number;
  route: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
  /** The page's last theme, so the window opens in it (CR-017). */
  dark?: boolean;
  recent: string[];
}
const saved: SavedState = {
  workspace: join(app.getPath('userData'), 'workspaces', 'default'),
  port: 0,
  route: '/',
  width: 1440,
  height: 900,
  maximized: false,
  recent: [],
};
try {
  const value = JSON.parse(readFileSync(stateFile, 'utf8'));
  if (typeof value.workspace === 'string' && isAbsolute(value.workspace))
    saved.workspace = value.workspace;
  if (Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535)
    saved.port = value.port;
  saved.route = localRoute(value.route);
  for (const key of ['width', 'height'] as const)
    if (Number.isInteger(value[key]) && value[key] >= 600 && value[key] <= 7680)
      saved[key] = value[key];
  if (Number.isInteger(value.x) && Number.isInteger(value.y)) {
    saved.x = value.x;
    saved.y = value.y;
  }
  saved.maximized = value.maximized === true;
  if (typeof value.dark === 'boolean') saved.dark = value.dark;
  saved.recent = recentWorkspaces(value.recent, saved.workspace);
} catch {
  /* First launch or invalid saved window state uses defaults. */
}

let window: BrowserWindow | null = null;
let child: ChildProcess | null = null;
let origin: string | null = null;
let status: 'starting' | 'ready' | 'failed' = 'starting';
let gitAvailable = false;
let closing = false;
let switching = false;
let allowQuit = false;
let generation = 0;
const persist = () => {
  try {
    if (window && !window.isDestroyed()) {
      Object.assign(saved, window.getNormalBounds());
      saved.maximized = window.isMaximized();
    }
    mkdirSync(app.getPath('userData'), { recursive: true, mode: 0o700 });
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(saved), { mode: 0o600 });
    renameSync(`${stateFile}.tmp`, stateFile);
  } catch {
    /* A read-only preference directory must not prevent a clean shutdown. */
  }
};

async function activeRuns(): Promise<number | null> {
  const sidecar = child;
  if (!sidecar?.connected) return sidecar ? null : 0;
  const id = crypto.randomUUID();
  return new Promise((done) => {
    const timer = setTimeout(() => finish(null), 2000);
    const receive = (value: unknown) => {
      const message = value as { type?: string; id?: string; active?: unknown };
      if (message.type === 'status' && message.id === id && typeof message.active === 'number')
        finish(message.active);
    };
    const finish = (value: number | null) => {
      clearTimeout(timer);
      sidecar.off('message', receive);
      done(value);
    };
    sidecar.on('message', receive);
    sidecar.send({ type: 'status', id }, (error) => {
      if (error) finish(null);
    });
  });
}

async function confirmStop(): Promise<boolean> {
  const active = await activeRuns();
  if (active === 0 || !window) return true;
  const ko = app.getLocale().startsWith('ko');
  const result = await dialog.showMessageBox(window, {
    type: 'question',
    message: ko ? '진행 중인 작업을 중단할까요?' : 'Stop the current work?',
    detail: ko
      ? '실행 중인 작업이 중단될 수 있습니다. 기록은 보존되며 다음에 자동 재개하지 않습니다.'
      : 'Active runs will be interrupted. Their history is kept; they will not resume automatically.',
    buttons: ko ? ['계속 실행', '중단하고 계속'] : ['Keep running', 'Stop and continue'],
    defaultId: 0,
    cancelId: 0,
  });
  return result.response === 1;
}

async function stopServer() {
  const sidecar = child;
  child = null;
  generation++;
  origin = null;
  if (!sidecar || sidecar.exitCode !== null || sidecar.signalCode !== null) return;
  await new Promise<void>((done) => {
    const force = setTimeout(() => {
      // The sidecar owns its process group, including Pi children. Never leave them running.
      try {
        if (sidecar.pid) process.kill(-sidecar.pid, 'SIGKILL');
      } catch {
        sidecar.kill('SIGKILL');
      }
      done();
    }, 8000);
    sidecar.once('exit', () => {
      clearTimeout(force);
      done();
    });
    if (sidecar.connected) sidecar.send({ type: 'stop' }, () => {});
    else sidecar.kill('SIGTERM');
  });
}

async function startServer() {
  if (!window || child) return;
  status = 'starting';
  origin = null;
  const own = ++generation;
  const fail = () => {
    if (own !== generation || closing) return;
    status = 'failed';
    origin = null;
    if (window && !window.isDestroyed())
      void window.loadURL(STARTUP).catch(() => {
        dialog.showErrorBox(
          'Corral could not start',
          'The recovery screen is unavailable. Reinstall Corral; workspace files have been kept.',
        );
      });
  };
  try {
    await window.loadURL(STARTUP);
    mkdirSync(saved.workspace, { recursive: true, mode: 0o700 });
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    delete env.ELECTRON_RUN_AS_NODE;
    child = fork(
      join(runtime, 'server/sidecar.mjs'),
      [
        saved.workspace,
        join(runtime, 'studio'),
        String(saved.port),
        String(process.argv.includes('--mock-only')),
        join(app.getPath('userData'), 'worktrees'),
      ],
      {
        execPath: join(runtime, 'node'),
        cwd: saved.workspace,
        env,
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'json',
        execArgv: [],
      },
    );
    const sidecar = child;
    const timer = setTimeout(() => {
      if (own === generation) {
        fail();
        void stopServer();
      }
    }, 30000);
    sidecar.on('message', (value: unknown) => {
      if (own !== generation) return;
      const message = value as {
        type?: string;
        url?: string;
        bootstrapUrl?: string;
        git?: boolean;
      };
      if (message.type === 'failed') {
        clearTimeout(timer);
        fail();
        return;
      }
      if (message.type !== 'ready' || !message.url || !message.bootstrapUrl) return;
      const url = new URL(message.url);
      const bootstrap = new URL(message.bootstrapUrl);
      if (
        url.hostname !== '127.0.0.1' ||
        url.protocol !== 'http:' ||
        bootstrap.origin !== url.origin
      ) {
        fail();
        void stopServer();
        return;
      }
      clearTimeout(timer);
      origin = url.origin;
      saved.port = Number(url.port);
      status = 'ready';
      gitAvailable = message.git === true;
      persist();
      if (window && !window.isDestroyed())
        void window.loadURL(`${origin}${localRoute(saved.route)}${bootstrap.hash}`).catch(fail);
    });
    sidecar.once('error', () => {
      clearTimeout(timer);
      fail();
    });
    sidecar.once('exit', () => {
      clearTimeout(timer);
      if (child === sidecar) child = null;
      fail();
    });
  } catch {
    fail();
  }
}

async function quit() {
  if (closing || switching) return;
  closing = true;
  if (!(await confirmStop())) {
    closing = false;
    return;
  }
  persist();
  await stopServer();
  allowQuit = true;
  app.quit();
}

async function chooseWorkspace() {
  if (!window || switching || closing) return;
  const choice = await dialog.showOpenDialog(window, {
    title: 'Open Corral workspace',
    properties: ['openDirectory', 'createDirectory'],
  });
  const path = choice.filePaths[0];
  if (choice.canceled || !path) return;
  await openWorkspaceAt(path);
}

async function openWorkspaceAt(path: string) {
  if (!window || switching || closing || path === saved.workspace || !isAbsolute(path)) return;
  switching = true;
  try {
    if (!(await confirmStop())) return;
    await stopServer();
    saved.workspace = path;
    saved.recent = recentWorkspaces(saved.recent, path);
    saved.route = '/';
    saved.port = 0;
    persist();
    buildMenu();
    await startServer();
  } finally {
    switching = false;
  }
}

/** Asks the page to run one of its own commands (CR-017); the page decides what it does. */
const command = (id: DesktopCommand) => () => {
  if (window && !window.isDestroyed() && status === 'ready')
    window.webContents.send('desktop:command', id);
};

function buildMenu() {
  const ko = app.getLocale().startsWith('ko');
  const say = (en: string, kr: string) => (ko ? kr : en);
  const recent: MenuItemConstructorOptions[] = saved.recent
    .filter((path) => path !== saved.workspace)
    .map((path) => ({ label: path, click: () => void openWorkspaceAt(path) }));
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: say('File', '파일'),
        submenu: [
          {
            label: say('New session', '새 세션'),
            accelerator: 'CommandOrControl+N',
            click: command('session.new'),
          },
          { type: 'separator' },
          { label: say('Open workspace…', '작업 공간 열기…'), click: () => void chooseWorkspace() },
          {
            label: say('Open recent', '최근 작업 공간'),
            enabled: recent.length > 0,
            submenu: recent.length ? recent : [{ label: '—', enabled: false }],
          },
          { type: 'separator' },
          {
            label: say('Settings', '설정'),
            accelerator: 'CommandOrControl+,',
            click: command('settings'),
          },
          { type: 'separator' },
          {
            label: say('Quit', '종료'),
            accelerator: 'CommandOrControl+Q',
            click: () => void quit(),
          },
        ],
      },
      {
        role: 'editMenu',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'pasteAndMatchStyle', accelerator: 'CommandOrControl+Shift+V' },
          { role: 'selectAll' },
        ],
      },
      {
        label: say('View', '보기'),
        submenu: [
          {
            label: say('Command palette', '명령 팔레트'),
            accelerator: 'CommandOrControl+K',
            click: command('palette'),
          },
          {
            label: say('Toggle sidebar', '사이드바'),
            accelerator: 'CommandOrControl+B',
            click: command('view.sidebar'),
          },
          {
            label: say('Toggle side panel', '사이드 패널'),
            accelerator: 'CommandOrControl+Alt+B',
            click: command('view.panel'),
          },
          {
            label: say('Go to request box', '요청 입력칸으로'),
            accelerator: 'CommandOrControl+L',
            click: command('composer.focus'),
          },
          { type: 'separator' },
          {
            label: say('Back', '뒤로'),
            accelerator: 'CommandOrControl+[',
            click: command('nav.back'),
          },
          {
            label: say('Forward', '앞으로'),
            accelerator: 'CommandOrControl+]',
            click: command('nav.forward'),
          },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          { role: 'reload' },
          { role: 'toggleDevTools' },
        ],
      },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [
          {
            label: say('Keyboard shortcuts', '키보드 단축키'),
            accelerator: 'CommandOrControl+/',
            click: command('help'),
          },
          {
            label: say('Releases', '릴리스'),
            click: () => void shell.openExternal('https://github.com/fromiron/corral/releases'),
          },
        ],
      },
    ]),
  );
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  app.on('before-quit', (event) => {
    if (!allowQuit) {
      event.preventDefault();
      void quit();
    }
  });
  void app.whenReady().then(async () => {
    electronSession.fromPartition('persist:corral').protocol.handle('corral', (request) => {
      const url = new URL(request.url);
      const name = (
        {
          '/': 'startup.html',
          '/startup.js': 'startup.js',
          '/startup.css': 'startup.css',
        } as Record<string, string>
      )[url.pathname];
      if (url.hostname !== 'startup' || !name) return new Response('', { status: 404 });
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
    const display = screen.getDisplayMatching({
      x: saved.x ?? 0,
      y: saved.y ?? 0,
      width: saved.width,
      height: saved.height,
    }).workArea;
    const fits =
      saved.x !== undefined &&
      saved.y !== undefined &&
      saved.x < display.x + display.width &&
      saved.y < display.y + display.height &&
      saved.x + saved.width > display.x &&
      saved.y + saved.height > display.y;
    const colors = themeColors(saved.dark ?? nativeTheme.shouldUseDarkColors) ?? {
      background: '#151615',
      overlay: '#151615',
      symbol: '#ececea',
    };
    window = new BrowserWindow({
      width: Math.min(saved.width, display.width),
      height: Math.min(saved.height, display.height),
      ...(fits ? { x: saved.x, y: saved.y } : {}),
      minWidth: 800,
      minHeight: 600,
      title: 'Corral',
      // CR-017: the page draws the title bar; the system draws the window buttons over it.
      ...(process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 } }
        : {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: { color: colors.overlay, symbolColor: colors.symbol, height: 52 },
          }),
      backgroundColor: colors.background,
      show: false,
      webPreferences: {
        preload: join(import.meta.dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        partition: 'persist:corral',
      },
    });
    if (saved.maximized) window.maximize();
    window.once('ready-to-show', () => window?.show());
    // Size and place are kept as they change, not only on quit, so a crash keeps them.
    let bounds: NodeJS.Timeout | null = null;
    const keepBounds = () => {
      if (bounds) clearTimeout(bounds);
      bounds = setTimeout(persist, 500);
    };
    for (const name of ['resize', 'move', 'maximize', 'unmaximize'] as const)
      window.on(name as 'resize', keepBounds);
    const contents = window.webContents;
    // Text fields get cut, copy, paste and spelling; links get "copy link" (CR-017).
    contents.on('context-menu', (_event, params) => {
      const ko = app.getLocale().startsWith('ko');
      const items: MenuItemConstructorOptions[] = [
        ...params.dictionarySuggestions.slice(0, 5).map(
          (word): MenuItemConstructorOptions => ({
            label: word,
            click: () => contents.replaceMisspelling(word),
          }),
        ),
        ...(params.dictionarySuggestions.length ? [{ type: 'separator' as const }] : []),
        ...(params.isEditable
          ? ([
              { role: 'cut', enabled: params.editFlags.canCut },
              { role: 'copy', enabled: params.editFlags.canCopy },
              { role: 'paste', enabled: params.editFlags.canPaste },
              { type: 'separator' },
              { role: 'selectAll' },
            ] as MenuItemConstructorOptions[])
          : params.selectionText
            ? ([{ role: 'copy' }] as MenuItemConstructorOptions[])
            : []),
        ...(externalUrl(params.linkURL)
          ? [
              {
                label: ko ? '링크 복사' : 'Copy link',
                click: () => clipboard.writeText(params.linkURL),
              },
            ]
          : []),
      ];
      if (items.length && window) Menu.buildFromTemplate(items).popup({ window });
    });
    contents.on('render-process-gone', () => {
      if (closing) return;
      status = 'failed';
      origin = null;
      void contents.loadURL(STARTUP).catch(() => {
        dialog.showErrorBox('Corral could not recover', 'Restart Corral to reopen this workspace.');
      });
    });
    contents.session.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
    contents.session.setPermissionCheckHandler(() => false);
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      const safe = externalUrl(url);
      if (safe) void shell.openExternal(safe);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (!trustedSender(url, origin, STARTUP, true)) {
        event.preventDefault();
        const safe = externalUrl(url);
        if (safe) void shell.openExternal(safe);
      }
    });
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame && origin && new URL(url).origin === origin) {
        const parsed = new URL(url);
        saved.route = localRoute(`${parsed.pathname}${parsed.search}`);
        persist();
      }
    });
    window.on('close', (event) => {
      if (!allowQuit) {
        event.preventDefault();
        void quit();
      }
    });
    window.on('closed', () => {
      window = null;
    });
    const handle = (name: string, action: (...args: unknown[]) => unknown) =>
      ipcMain.handle(`desktop:${name}`, (event, ...args: unknown[]) => {
        if (
          !window ||
          event.sender !== window.webContents ||
          !trustedSender(
            event.senderFrame?.url ?? '',
            origin,
            STARTUP,
            event.senderFrame === window.webContents.mainFrame,
          )
        )
          throw new Error('Untrusted desktop request');
        return action(...args);
      });
    handle('info', () => ({
      version: app.getVersion(),
      platform: process.platform,
      overlay: process.platform !== 'darwin',
      status,
      gitAvailable,
      workspace: saved.workspace,
      node: '24.19.0',
    }));
    handle('window', (action) => {
      if (action === 'minimize') window?.minimize();
      else if (action === 'maximize') {
        if (window?.isMaximized()) window.unmaximize();
        else window?.maximize();
      } else if (action === 'close') void quit();
      else throw new Error('Unknown window action');
    });
    handle('theme', (dark) => {
      const next = themeColors(dark);
      if (!next || !window) throw new Error('Unknown theme');
      saved.dark = dark as boolean;
      window.setBackgroundColor(next.background);
      if (process.platform !== 'darwin')
        window.setTitleBarOverlay({ color: next.overlay, symbolColor: next.symbol });
    });
    handle('notify', (value) => {
      const text = notificationText(value);
      if (!text || !window || window.isFocused() || !Notification.isSupported()) return false;
      const note = new Notification({ ...text, silent: false });
      note.on('click', () => {
        window?.show();
        window?.focus();
      });
      note.show();
      return true;
    });
    handle('badge', (count) => {
      app.setBadgeCount(
        Number.isInteger(count) && (count as number) >= 0 ? Math.min(count as number, 999) : 0,
      );
    });
    handle('pick-folder', async () => {
      if (!window) return null;
      const selected = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
      return selected.canceled ? null : (selected.filePaths[0] ?? null);
    });
    handle('open-workspace', chooseWorkspace);
    handle('reveal-workspace', () => {
      if (existsSync(saved.workspace)) shell.showItemInFolder(saved.workspace);
    });
    handle('external', (value) => {
      const url = externalUrl(value);
      if (!url) throw new Error('Only HTTP(S) links can be opened');
      return shell.openExternal(url);
    });
    handle('retry', async () => {
      if (switching || closing) return;
      switching = true;
      try {
        if (!(await confirmStop())) return;
        await stopServer();
        await startServer();
      } finally {
        switching = false;
      }
    });
    buildMenu();
    await startServer();
  });
}
