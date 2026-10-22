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
  nativeImage,
  nativeTheme,
  powerSaveBlocker,
  protocol,
  screen,
  shell,
  Tray,
} from 'electron';
import { type DesktopRun, RunSleepBlocker, runRoute } from './lifecycle.ts';
import { type DesktopLocale, nativeLocale, parseDesktopLocale } from './locale.ts';
import { installStudioMicrophone } from './microphone.ts';
import { DesktopPreviews } from './preview.ts';
import { RemoteHostController } from './remote-host-controller.ts';
import {
  type DesktopCommand,
  desktopAccelerators,
  externalUrl,
  localRoute,
  notificationText,
  recentWorkspaces,
  themeColors,
  trustedSender,
} from './security.ts';
import { hasWindowUnsavedEdits } from './unsaved.ts';
import { DesktopUpdater } from './updater.ts';

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
  closeToTray: boolean;
  keepAwake: boolean;
  keepAwakeWhileWaiting: boolean;
  /** The language chosen in the app; native menus and dialogs follow it (#84). */
  locale?: DesktopLocale;
}
const saved: SavedState = {
  workspace: join(app.getPath('userData'), 'workspaces', 'default'),
  port: 0,
  route: '/',
  width: 1440,
  height: 900,
  maximized: false,
  recent: [],
  closeToTray: false,
  keepAwake: true,
  keepAwakeWhileWaiting: false,
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
  const locale = parseDesktopLocale(value.locale);
  if (locale) saved.locale = locale;
  saved.recent = recentWorkspaces(value.recent, saved.workspace);
  for (const key of ['closeToTray', 'keepAwake', 'keepAwakeWhileWaiting'] as const)
    if (typeof value[key] === 'boolean') saved[key] = value[key];
} catch {
  /* First launch or invalid saved window state uses defaults. */
}

let window: BrowserWindow | null = null;
let child: ChildProcess | null = null;
let origin: string | null = null;
let status: 'starting' | 'ready' | 'failed' = 'starting';
let cleanupFailed = false;
let gitAvailable = false;
let closing = false;
let switching = false;
let allowQuit = false;
let discardEdits = false;
let generation = 0;
let tray: Tray | null = null;
let remoteHosts: RemoteHostController | null = null;
let updater: DesktopUpdater | null = null;
let keybindings: Partial<Record<DesktopCommand, string>> | null = null;
let capturingShortcut = false;
const accelerator = (id: DesktopCommand, fallback: string) =>
  keybindings === null ? fallback : keybindings[id];
let activityTimer: NodeJS.Timeout | null = null;
let desktopRuns: DesktopRun[] = [];
let pollingActivity = false;
const awake = new RunSleepBlocker(powerSaveBlocker);
const previews = new DesktopPreviews(
  async (sessionId, leaseId) =>
    (await sidecarRequest({ type: 'preview-target', sessionId, leaseId })).target,
);

function showWindow() {
  if (window?.isMinimized()) window.restore();
  window?.show();
  window?.focus();
}

function refreshTray() {
  awake.update(desktopRuns, saved.keepAwake, saved.keepAwakeWhileWaiting);
  if (!tray) return;
  const ko = korean();
  tray.setToolTip(`Corral · ${desktopRuns.length} ${ko ? '진행 중' : 'active'}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: ko ? 'Corral 열기' : 'Open Corral', click: showWindow },
      ...desktopRuns.slice(0, 20).map(
        (run): MenuItemConstructorOptions => ({
          label: `${run.title || (ko ? '작업' : 'Work')} · ${
            (
              {
                running: ko ? '실행 중' : 'Running',
                paused: ko ? '일시정지' : 'Paused',
                awaiting_user: ko ? '응답 필요' : 'Needs input',
                cancelling: ko ? '취소 중' : 'Cancelling',
              } as Record<string, string>
            )[run.status] ?? (ko ? '준비 중' : 'Preparing')
          }`,
          submenu: [
            {
              label: ko ? '작업 열기' : 'Open work',
              click: () => {
                showWindow();
                if (origin && window) void window.loadURL(`${origin}${runRoute(run)}`);
              },
            },
            {
              label: ko ? '실행 취소…' : 'Cancel run…',
              enabled: run.status !== 'cancelling',
              click: () => void cancelTrayRun(run),
            },
          ],
        }),
      ),
      ...(desktopRuns.length
        ? []
        : [{ label: ko ? '진행 중인 작업 없음' : 'No active work', enabled: false }]),
      { type: 'separator' },
      { label: ko ? '종료' : 'Quit', click: () => void quit() },
    ]),
  );
}

async function cancelTrayRun(run: DesktopRun) {
  showWindow();
  if (!window || !child?.connected) return;
  const answer = await dialog.showMessageBox(window, {
    type: 'question',
    message: korean() ? '이 실행을 취소할까요?' : 'Cancel this run?',
    detail: run.title ?? '',
    buttons: korean() ? ['계속 실행', '실행 취소'] : ['Keep running', 'Cancel run'],
    defaultId: 0,
    cancelId: 0,
  });
  if (answer.response !== 1) return;
  try {
    await sidecarRequest({
      type: 'cancel-run',
      runId: run.runId,
      controlRevision: run.controlRevision,
    });
    await pollActivity();
  } catch {
    dialog.showErrorBox(
      'Corral',
      'The cancellation could not be confirmed. Open the run to inspect its state.',
    );
  }
}

async function sidecarRequest(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sidecar = child;
  if (!sidecar?.connected) throw new Error('Server unavailable');
  const id = crypto.randomUUID();
  return new Promise((done, reject) => {
    const finish = (value: Record<string, unknown> | null) => {
      clearTimeout(timer);
      sidecar.off('message', receive);
      if (value && !value.error) done(value);
      else reject(new Error('Server request failed'));
    };
    const receive = (value: unknown) => {
      if (value && typeof value === 'object' && 'id' in value && value.id === id)
        finish(value as Record<string, unknown>);
    };
    const timer = setTimeout(() => finish(null), 3000);
    sidecar.on('message', receive);
    sidecar.send({ ...message, id }, (error) => {
      if (error) finish(null);
    });
  });
}

async function pollActivity() {
  if (pollingActivity || status !== 'ready') return;
  const own = generation;
  pollingActivity = true;
  try {
    const activity = await sidecarRequest({ type: 'status' });
    if (own === generation && Array.isArray(activity.runs)) {
      desktopRuns = activity.runs as DesktopRun[];
      refreshTray();
    }
  } catch {
    // Unknown status must not be mistaken for all runs having stopped.
  } finally {
    pollingActivity = false;
  }
}
function korean() {
  return nativeLocale(saved.locale, app.getLocale()) === 'ko';
}
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

async function confirmStop(nextWorkspace?: string): Promise<boolean> {
  const active = await activeRuns();
  if (!window || (active === 0 && !nextWorkspace)) return true;
  const ko = korean();
  const result = await dialog.showMessageBox(window, {
    type: 'question',
    message: nextWorkspace
      ? ko
        ? '다른 데이터 폴더로 전환할까요?'
        : 'Switch data folder?'
      : ko
        ? '진행 중인 작업을 중단할까요?'
        : 'Stop the current work?',
    detail: nextWorkspace
      ? `${ko ? '앱 서버를 다시 시작합니다. 기존 데이터는 유지됩니다.' : 'The app server will restart. Existing data is kept.'}${active !== 0 ? (ko ? ' 진행 중인 작업은 중단되며 자동 재개하지 않습니다.' : ' Active work will stop and will not resume automatically.') : ''}\n\n${nextWorkspace}`
      : ko
        ? '실행 중인 작업이 중단될 수 있습니다. 기록은 보존되며 다음에 자동 재개하지 않습니다.'
        : 'Active runs will be interrupted. Their history is kept; they will not resume automatically.',
    buttons: nextWorkspace
      ? ko
        ? ['취소', '전환']
        : ['Cancel', 'Switch']
      : ko
        ? ['계속 실행', '중단하고 계속']
        : ['Keep running', 'Stop and continue'],
    defaultId: 0,
    cancelId: 0,
  });
  return result.response === 1;
}

async function stopServer(idleOnly = false) {
  if (cleanupFailed) return false;
  if (!idleOnly) previews.closeAll();
  const sidecar = child;
  if (!sidecar || sidecar.exitCode !== null || sidecar.signalCode !== null) return true;
  const stopped = await new Promise<boolean>((done) => {
    const finish = (confirmed: boolean) => {
      clearTimeout(force);
      sidecar.off('exit', exited);
      sidecar.off('message', refused);
      done(confirmed);
    };
    const exited = () => finish(true);
    const refused = (message: unknown) => {
      if (
        message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'stop-failed' &&
        'cleanupFailed' in message &&
        message.cleanupFailed === true
      ) {
        cleanupFailed = true;
        status = 'failed';
        origin = null;
        if (window && !window.isDestroyed()) {
          void window
            .loadURL(STARTUP)
            .catch(() =>
              dialog.showErrorBox(
                'Corral cleanup is incomplete',
                'Some resources could not be stopped safely. The app will retain ownership and will not reopen or switch workspaces.',
              ),
            );
          showWindow();
        }
        finish(false);
        return;
      }
      if (
        message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'stop-refused'
      )
        finish(false);
    };
    const force = setTimeout(() => {
      // An unconfirmed shutdown keeps the host and its ownership alive. In particular,
      // killing just the Windows parent could strand its descendants.
      finish(false);
    }, 15000);
    sidecar.once('exit', exited);
    sidecar.on('message', refused);
    if (sidecar.connected) sidecar.send({ type: idleOnly ? 'stop-if-idle' : 'stop' }, () => {});
  });
  if (!stopped) {
    if (!idleOnly) {
      showWindow();
      dialog.showErrorBox(
        'Corral could not stop',
        'Process cleanup is still pending. The app will stay open to preserve ownership. Wait for the work to stop and try again.',
      );
    }
    return false;
  }
  if (child === sidecar) child = null;
  generation++;
  origin = null;
  previews.closeAll();
  desktopRuns = [];
  refreshTray();
  return true;
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
        execPath: join(runtime, process.platform === 'win32' ? 'node.exe' : 'node'),
        cwd: saved.workspace,
        env,
        detached: true,
        windowsHide: true,
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
        cleanupFailed?: boolean;
        url?: string;
        bootstrapUrl?: string;
        git?: boolean;
      };
      if (message.type === 'failed') {
        clearTimeout(timer);
        if (message.cleanupFailed === true) cleanupFailed = true;
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
      void pollActivity();
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
      desktopRuns = [];
      refreshTray();
      fail();
    });
  } catch {
    fail();
  }
}

async function quit() {
  if (closing || switching) return;
  closing = true;
  if (await hasUnsavedEdits()) {
    showWindow();
    if (
      !window ||
      (
        await dialog.showMessageBox(window, {
          type: 'question',
          message: korean()
            ? '저장하지 않은 편집 내용을 버리고 종료할까요?'
            : 'Discard unsaved edits and quit?',
          buttons: korean() ? ['계속 편집', '버리고 종료'] : ['Keep editing', 'Discard and quit'],
          defaultId: 0,
          cancelId: 0,
        })
      ).response !== 1
    ) {
      closing = false;
      return;
    }
    discardEdits = true;
  }
  if (!(await confirmStop())) {
    closing = false;
    discardEdits = false;
    return;
  }
  persist();
  if (!(await stopServer())) {
    closing = false;
    discardEdits = false;
    return;
  }
  try {
    await remoteHosts?.dispose();
  } catch {
    closing = false;
    discardEdits = false;
    await startServer();
    showWindow();
    dialog.showErrorBox(
      'Corral',
      'Remote connection cleanup is still pending. Local work has been reopened; try quitting again after cleanup completes.',
    );
    return;
  }
  if (activityTimer) clearInterval(activityTimer);
  awake.dispose();
  tray?.destroy();
  allowQuit = true;
  app.quit();
}

async function hasUnsavedEdits() {
  return hasWindowUnsavedEdits(BrowserWindow.getAllWindows());
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
    if (await hasUnsavedEdits()) {
      await dialog.showMessageBox(window, {
        type: 'info',
        message: korean()
          ? '편집 내용을 저장한 뒤 작업 공간을 전환하세요.'
          : 'Save your edits before switching workspaces.',
      });
      return;
    }
    if (!(await confirmStop(path))) return;
    if (!(await stopServer())) return;
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
  const ko = korean();
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
            accelerator: accelerator('session.new', 'CommandOrControl+N'),
            click: command('session.new'),
          },
          { type: 'separator' },
          { label: say('Open workspace…', '작업 공간 열기…'), click: () => void chooseWorkspace() },
          {
            label: say('Open recent', '최근 작업 공간'),
            enabled: recent.length > 0,
            submenu: recent.length ? recent : [{ label: '—', enabled: false }],
          },
          ...(remoteHosts ? [remoteHosts.menuItem()] : []),
          {
            label: say('Show update backups', '업데이트 전 백업 보기'),
            click: () => {
              const backups = join(saved.workspace, '.corral', 'update-backups');
              if (existsSync(backups)) shell.showItemInFolder(backups);
              else if (window)
                void dialog.showMessageBox(window, {
                  type: 'info',
                  message: say(
                    'A workspace backup is created before an update is installed.',
                    '업데이트를 설치하기 전에 작업 공간 백업이 만들어집니다.',
                  ),
                });
            },
          },
          { type: 'separator' },
          {
            label: say('Settings', '설정'),
            accelerator: accelerator('settings', 'CommandOrControl+,'),
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
            accelerator: accelerator('palette', 'CommandOrControl+K'),
            click: command('palette'),
          },
          {
            label: say('Toggle sidebar', '사이드바'),
            accelerator: accelerator('view.sidebar', 'CommandOrControl+B'),
            click: command('view.sidebar'),
          },
          {
            label: say('Toggle side panel', '사이드 패널'),
            accelerator: accelerator('view.panel', 'CommandOrControl+Alt+B'),
            click: command('view.panel'),
          },
          {
            label: say('Go to request box', '요청 입력칸으로'),
            accelerator: accelerator('composer.focus', 'CommandOrControl+L'),
            click: command('composer.focus'),
          },
          { type: 'separator' },
          {
            label: say('Back', '뒤로'),
            accelerator: accelerator('nav.back', 'CommandOrControl+['),
            click: command('nav.back'),
          },
          {
            label: say('Forward', '앞으로'),
            accelerator: accelerator('nav.forward', 'CommandOrControl+]'),
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
        label: say('Background', '백그라운드'),
        submenu: [
          {
            label: say('Close window to tray', '창을 닫으면 트레이로 숨기기'),
            type: 'checkbox',
            checked: saved.closeToTray,
            enabled: !!tray,
            click: (item) => {
              saved.closeToTray = item.checked;
              persist();
            },
          },
          {
            label: say('Keep awake while working', '작업 중 절전 방지'),
            type: 'checkbox',
            checked: saved.keepAwake,
            click: (item) => {
              saved.keepAwake = item.checked;
              persist();
              refreshTray();
              buildMenu();
            },
          },
          {
            label: say(
              'Also keep awake while paused or awaiting input',
              '일시정지·응답 대기 중에도 절전 방지',
            ),
            type: 'checkbox',
            checked: saved.keepAwakeWhileWaiting,
            enabled: saved.keepAwake,
            click: (item) => {
              saved.keepAwakeWhileWaiting = item.checked;
              persist();
              refreshTray();
            },
          },
        ],
      },
      {
        role: 'help',
        submenu: [
          ...(updater?.menuItems() ?? []),
          {
            label: say('Keyboard shortcuts', '키보드 단축키'),
            accelerator: accelerator('help', 'CommandOrControl+/'),
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
    contents.on('will-prevent-unload', (event) => {
      if ((allowQuit || cleanupFailed) && discardEdits) event.preventDefault();
    });
    contents.on('before-input-event', (_event, input) => {
      contents.setIgnoreMenuShortcuts(
        capturingShortcut || input.isComposing || (input.control && input.alt),
      );
    });
    // Text fields get cut, copy, paste and spelling; links get "copy link" (CR-017).
    contents.on('context-menu', (_event, params) => {
      const ko = korean();
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
    installStudioMicrophone(contents.session, () => ({ window, origin }));
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
        if (saved.closeToTray && tray) {
          persist();
          window?.hide();
        } else void quit();
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
      cleanupFailed,
      gitAvailable,
      workspace: saved.workspace,
      node: '24.19.0',
    }));
    handle('window', (action) => {
      if (action === 'minimize') window?.minimize();
      else if (action === 'maximize') {
        if (window?.isMaximized()) window.unmaximize();
        else window?.maximize();
      } else if (action === 'close') window?.close();
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
    handle('locale', (value) => {
      const locale = parseDesktopLocale(value);
      if (!locale) throw new Error('Unknown locale');
      if (saved.locale === locale) return;
      saved.locale = locale;
      persist();
      buildMenu();
      refreshTray();
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
    handle('shortcuts', (value) => {
      keybindings = desktopAccelerators(value);
      capturingShortcut = Object.keys(value as object).length === 0;
      window?.webContents.setIgnoreMenuShortcuts(capturingShortcut);
      buildMenu();
    });
    handle('open-preview', (sessionId, leaseId) => {
      if (typeof sessionId !== 'string' || typeof leaseId !== 'string')
        throw new Error('Invalid preview identity');
      return previews.open(sessionId, leaseId);
    });
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
        if (!(await stopServer())) return;
        await startServer();
      } finally {
        switching = false;
      }
    });
    try {
      const icon = nativeImage.createFromPath(join(runtime, 'icon.png'));
      if (!icon.isEmpty()) {
        tray = new Tray(icon.resize({ width: 20, height: 20 }));
        tray.on('click', showWindow);
        refreshTray();
      }
    } catch {
      // Some desktop sessions have no notification area; closing continues to quit.
    }
    try {
      remoteHosts = new RemoteHostController(() => window, korean);
    } catch {
      dialog.showErrorBox(
        'Corral · Remote hosts',
        'Remote host registrations could not be opened. Local work remains available.',
      );
    }
    updater = new DesktopUpdater({
      parent: () => window,
      runtime,
      storageVersion: async () => {
        const response = await sidecarRequest({ type: 'update-status' });
        if (!Number.isSafeInteger(response.storageVersion)) throw new Error('Storage unavailable');
        return response.storageVersion as number;
      },
      changed: buildMenu,
      prepare: async () => {
        if (closing || switching) return false;
        closing = true;
        const windows = BrowserWindow.getAllWindows();
        for (const item of windows) item.setEnabled(false);
        const restore = () => {
          closing = false;
          for (const item of windows) if (!item.isDestroyed()) item.setEnabled(true);
        };
        try {
          if (await hasUnsavedEdits()) {
            restore();
            return false;
          }
          persist();
          if (!(await stopServer(true))) {
            restore();
            return false;
          }
          previews.closeAll();
          await remoteHosts?.dispose();
          remoteHosts = null;
          awake.dispose();
          allowQuit = true;
          return true;
        } catch {
          restore();
          if (!child) await startServer();
          return false;
        }
      },
      recover: async () => {
        closing = false;
        allowQuit = false;
        for (const item of BrowserWindow.getAllWindows()) item.setEnabled(true);
        if (!remoteHosts) remoteHosts = new RemoteHostController(() => window, korean);
        await startServer();
        buildMenu();
      },
    });
    activityTimer = setInterval(() => void pollActivity(), 2000);
    activityTimer.unref();
    buildMenu();
    await startServer();
  });
}
