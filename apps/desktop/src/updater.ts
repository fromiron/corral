import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, type BrowserWindow, dialog, type MenuItemConstructorOptions } from 'electron';
import electronUpdater, { type AppUpdater, type UpdateCheckResult } from 'electron-updater';
import { compatibleUpdate, updateChannel } from './update-policy.ts';

export class DesktopUpdater {
  private updater: AppUpdater | null = null;
  private state:
    | 'disabled'
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'ready'
    | 'failed' = 'disabled';
  private version = '';
  private disabledReason: 'channel' | 'installation' = 'channel';
  private restarting = false;
  private percent = 0;
  private cancelled = false;
  private cancellation: UpdateCheckResult['cancellationToken'];
  private info: unknown;
  private storageVersion: () => Promise<number>;
  private parent: () => BrowserWindow | null;
  private changed: () => void;
  private prepare: () => Promise<boolean>;
  private recover: () => Promise<void>;

  constructor(options: {
    parent: () => BrowserWindow | null;
    changed: () => void;
    prepare: () => Promise<boolean>;
    recover: () => Promise<void>;
    runtime: string;
    storageVersion: () => Promise<number>;
  }) {
    this.parent = options.parent;
    this.changed = options.changed;
    this.prepare = options.prepare;
    this.recover = options.recover;
    this.storageVersion = options.storageVersion;
    // The portable archive is a manual distribution, not an NSIS installation.
    if (
      !app.isPackaged ||
      process.env.PORTABLE_EXECUTABLE_FILE ||
      (process.platform === 'win32' &&
        !existsSync(join(dirname(process.execPath), 'Uninstall Corral.exe')))
    ) {
      this.disabledReason = 'installation';
      return;
    }
    if (!existsSync(join(process.resourcesPath, 'app-update.yml'))) return;
    try {
      updateChannel(
        JSON.parse(readFileSync(join(options.runtime, 'update-channel.json'), 'utf8')),
        process.platform,
      );
    } catch {
      return;
    }
    const updater = electronUpdater.autoUpdater;
    updater.logger = null;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    updater.on('error', () => {
      if (this.cancelled) return;
      this.state = 'failed';
      this.changed();
      if (this.restarting) {
        this.restarting = false;
        void this.recover();
      }
    });
    updater.on('download-progress', (progress) => {
      const percent = Math.min(100, Math.max(0, Math.floor(progress.percent)));
      if (this.percent !== percent) {
        this.percent = percent;
        this.changed();
      }
    });
    this.updater = updater;
    this.state = 'idle';
  }

  menuItems(): MenuItemConstructorOptions[] {
    const ko = app.getLocale().startsWith('ko');
    const say = (en: string, kr: string) => (ko ? kr : en);
    return [
      {
        label:
          this.state === 'disabled'
            ? this.disabledReason === 'installation'
              ? say('Updates require an installed app', '설치형 앱에서 업데이트 가능')
              : say('Updates: release channel not configured', '업데이트: 배포 채널 미설정')
            : this.state === 'checking'
              ? say('Checking for updates…', '업데이트 확인 중…')
              : this.state === 'downloading'
                ? say(
                    `Downloading update… ${this.percent}%`,
                    `업데이트 다운로드 중… ${this.percent}%`,
                  )
                : say('Check for updates', '업데이트 확인'),
        enabled: !['disabled', 'checking', 'downloading'].includes(this.state),
        click: () => void this.check(),
      },
      ...(this.state === 'available'
        ? [
            {
              label: say(`Download ${this.version}`, `${this.version} 다운로드`),
              click: () => void this.download(),
            },
          ]
        : []),
      ...(this.state === 'downloading' && this.cancellation
        ? [
            {
              label: say('Cancel download', '다운로드 취소'),
              click: () => {
                this.cancelled = true;
                this.cancellation?.cancel();
              },
            },
          ]
        : []),
      ...(this.state === 'ready'
        ? [
            {
              label: say(`Restart to apply ${this.version}…`, `${this.version} 적용 후 다시 시작…`),
              click: () => void this.install(),
            },
          ]
        : []),
    ];
  }

  private async notice(message: string) {
    const parent = this.parent();
    if (parent) await dialog.showMessageBox(parent, { type: 'info', message, buttons: ['OK'] });
  }

  private async check() {
    if (!this.updater || ['checking', 'downloading'].includes(this.state)) return;
    this.state = 'checking';
    this.changed();
    try {
      const result = await this.updater.checkForUpdates();
      if (!result?.isUpdateAvailable) {
        this.state = 'idle';
        await this.notice(
          app.getLocale().startsWith('ko')
            ? '적용 가능한 업데이트가 없습니다.'
            : 'No eligible update is available.',
        );
      } else if (!compatibleUpdate(result.updateInfo, await this.storageVersion())) {
        this.state = 'failed';
        await this.notice(
          app.getLocale().startsWith('ko')
            ? '배포 정보에 호환 저장소 형식 또는 다운로드 검증 정보가 없습니다. 배포 담당자가 확인해야 합니다.'
            : 'Release metadata is missing compatible storage schema or download integrity information. Ask the release owner to verify this update.',
        );
      } else {
        this.version = result.updateInfo.version;
        this.info = result.updateInfo;
        this.cancellation = result.cancellationToken;
        this.cancelled = false;
        this.state = 'available';
      }
    } catch {
      this.state = 'failed';
      await this.notice(
        app.getLocale().startsWith('ko')
          ? '업데이트를 확인하지 못했습니다.'
          : 'Could not check for updates.',
      );
    } finally {
      this.changed();
    }
  }

  private async download() {
    if (this.state !== 'available' || !this.updater) return;
    this.state = 'downloading';
    this.percent = 0;
    this.changed();
    try {
      await this.updater.downloadUpdate(this.cancellation);
      this.state = this.cancelled ? 'idle' : 'ready';
    } catch {
      if (this.cancelled) {
        this.state = 'idle';
        return;
      }
      this.state = 'failed';
      await this.notice(
        app.getLocale().startsWith('ko')
          ? '업데이트를 다운로드하거나 검증하지 못했습니다.'
          : 'The update could not be downloaded or verified.',
      );
    } finally {
      this.changed();
    }
  }

  private async install() {
    const parent = this.parent();
    if (this.state !== 'ready' || !this.updater || !parent || this.restarting) return;
    const answer = await dialog.showMessageBox(parent, {
      type: 'question',
      message: app.getLocale().startsWith('ko')
        ? '업데이트를 적용하고 다시 시작할까요?'
        : 'Apply the update and restart?',
      detail: app.getLocale().startsWith('ko')
        ? '진행 중인 실행이나 저장하지 않은 편집 내용이 있으면 재시작을 미룹니다.'
        : 'Restart is deferred while work or unsaved edits remain.',
      buttons: app.getLocale().startsWith('ko') ? ['나중에', '다시 시작'] : ['Later', 'Restart'],
      defaultId: 0,
      cancelId: 0,
    });
    if (answer.response !== 1) return;
    try {
      if (!compatibleUpdate(this.info, await this.storageVersion())) {
        await this.notice(
          app.getLocale().startsWith('ko')
            ? '현재 저장소 형식과 업데이트의 호환성을 확인하지 못했습니다.'
            : 'Could not confirm update compatibility with the current workspace storage.',
        );
        return;
      }
    } catch {
      return;
    }
    if (!(await this.prepare())) {
      await this.notice(
        app.getLocale().startsWith('ko')
          ? '진행 중인 작업 또는 저장하지 않은 편집 내용을 마친 뒤 다시 시도하세요.'
          : 'Finish active work and save your edits before restarting.',
      );
      return;
    }
    this.restarting = true;
    try {
      this.updater.quitAndInstall(false, true);
    } catch {
      this.restarting = false;
      await this.recover();
    }
  }
}
