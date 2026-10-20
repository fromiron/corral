import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Scheduler } from '@corral/contracts';
import { killProcessGroup, processGroupGone } from '../files/process-group.ts';
import { spawnOwnedProcess } from '../processes/owned-process.ts';

export interface CloneOperation {
  id: string;
  commandId: string;
  destination: string;
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  progress: string;
  cleanupConfirmed: boolean;
  partialDirectory: boolean;
  requestHash: string;
  directoryIdentity: string;
}
const timers: Scheduler = {
  after: (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

function validateSource(source: string) {
  if (/[\0\r\n]/.test(source) || source.startsWith('-'))
    throw new Error('Invalid repository source.');
  if (/^https?:\/\//i.test(source)) {
    const url = new URL(source);
    if (url.username || url.password || url.search || url.hash)
      throw new Error('Repository URLs must not contain credentials, queries or fragments.');
    if (url.protocol !== 'https:') throw new Error('Use an HTTPS or SSH repository URL.');
  } else if (/^ssh:\/\//i.test(source)) {
    const url = new URL(source);
    if (url.password || url.search || url.hash)
      throw new Error('Repository URLs must not contain credentials.');
  } else if (!/^[\w.-]+@[\w.-]+:[^\s]+$/.test(source) && !isAbsolute(source)) {
    throw new Error('Use an HTTPS URL, SSH URL or absolute local repository path.');
  }
}

/** Owns only freshly reserved destinations. Clone never grants workspace trust or runs checkout hooks. */
export class ProjectClones {
  private readonly path: string;
  private readonly template: string;
  private operations: CloneOperation[];
  private live = new Map<
    string,
    { child?: ChildProcess; cancelled: boolean; promise: Promise<void> }
  >();
  constructor(root: string) {
    mkdirSync(root, { recursive: true });
    this.template = join(root, 'empty-git-template');
    mkdirSync(this.template, { recursive: true });
    this.path = join(root, 'clones.json');
    this.operations = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : [];
    for (const op of this.operations) {
      if (op.state === 'running') {
        op.state = 'interrupted';
        op.progress =
          'Server restarted. The partial directory is retained; no process was replayed.';
        op.cleanupConfirmed = false;
      }
    }
    this.persist();
  }
  private persist() {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.operations), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
  list() {
    return this.operations.map((item) => ({ ...item }));
  }
  get(id: string) {
    const op = this.operations.find((item) => item.id === id);
    if (!op) throw new Error('Clone operation does not exist.');
    return { ...op };
  }
  start(input: { commandId: string; source: string; destination: string }) {
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const previous = this.operations.find((item) => item.commandId === input.commandId);
    if (previous) {
      if (previous.requestHash !== requestHash)
        throw new Error('This command was already used for another clone.');
      return { ...previous };
    }
    validateSource(input.source);
    if (!isAbsolute(input.destination)) throw new Error('Choose an absolute destination path.');
    const destination = join(
      realpathSync(dirname(resolve(input.destination))),
      basename(input.destination),
    );
    if (existsSync(destination))
      throw new Error('The destination already exists. Choose a new folder.');
    mkdirSync(destination); // atomic reservation: never clone over an existing directory
    const identity = lstatSync(destination, { bigint: true });
    const op: CloneOperation = {
      id: `clone_${randomUUID()}`,
      commandId: input.commandId,
      destination,
      state: 'running',
      progress: 'Receiving repository',
      cleanupConfirmed: true,
      partialDirectory: true,
      requestHash,
      directoryIdentity: `${identity.dev}:${identity.ino}`,
    };
    this.operations.push(op);
    this.persist();
    const owner = { cancelled: false, promise: Promise.resolve() } as {
      child?: ChildProcess;
      cancelled: boolean;
      promise: Promise<void>;
    };
    this.live.set(op.id, owner);
    owner.promise = this.execute(op, input.source, owner);
    return { ...op };
  }
  private async execute(
    op: CloneOperation,
    source: string,
    owner: { child?: ChildProcess; cancelled: boolean },
  ) {
    try {
      const cloned = await this.phase(
        op,
        owner,
        [
          'clone',
          '--no-checkout',
          '--no-local',
          '--progress',
          `--template=${this.template}`,
          '--',
          source,
          op.destination,
        ],
        false,
      );
      if (!cloned || owner.cancelled) return;
      let hasRefs = false;
      if (
        !(await this.phase(
          op,
          owner,
          ['-C', op.destination, 'for-each-ref', '--count=1', '--format=%(objectname)'],
          true,
          (chunk) => {
            if (chunk.trim()) hasRefs = true;
          },
        ))
      )
        return;
      op.progress = 'Checking out files';
      this.persist();
      // No user/system filter drivers or repository hooks are executed during checkout.
      const checkedOut = await this.phase(
        op,
        owner,
        ['-C', op.destination, 'read-tree', ...(hasRefs ? ['--reset', '-u', 'HEAD'] : ['--empty'])],
        true,
      );
      if (checkedOut && !owner.cancelled) {
        op.state = 'completed';
        op.partialDirectory = false;
        op.progress = 'Cloned. Link the folder, then explicitly choose whether to trust it.';
      }
    } catch {
      op.state = 'failed';
      op.progress = 'Clone failed. Check Git access and the repository address.';
    } finally {
      if (owner.cancelled && op.cleanupConfirmed) {
        op.state = 'cancelled';
        op.progress = 'Cancelled; processes stopped. The partial directory can be removed.';
      } else if (op.state === 'running') {
        op.state = 'failed';
        op.progress = 'Clone failed. The partial directory is retained.';
      }
      this.persist();
      this.live.delete(op.id);
    }
  }
  private async phase(
    op: CloneOperation,
    owner: { child?: ChildProcess; cancelled: boolean },
    args: string[],
    checkout: boolean,
    output?: (chunk: string) => void,
  ) {
    if (owner.cancelled) return false;
    const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '0' };
    for (const key of [
      'PATH',
      'Path',
      'SystemRoot',
      'WINDIR',
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'TEMP',
      'TMP',
      'SSH_AUTH_SOCK',
    ])
      if (process.env[key]) env[key] = process.env[key] ?? '';
    if (checkout) {
      env.GIT_CONFIG_NOSYSTEM = '1';
      env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
    }
    const child = spawnOwnedProcess(
      'git',
      ['-c', `core.hooksPath=${this.template}`, '-c', 'core.fsmonitor=false', ...args],
      { cwd: dirname(op.destination), env, windowsHide: true },
    );
    owner.child = child;
    op.cleanupConfirmed = false;
    this.persist();
    if (output) child.stdout?.on('data', (chunk: Buffer) => output(chunk.toString()));
    else child.stdout?.resume();
    child.stderr?.on('data', (chunk: Buffer) => {
      const percentage = chunk.toString().match(/(\d{1,3})%/);
      if (percentage) {
        op.progress = `${checkout ? 'Checking out' : 'Receiving repository'}: ${percentage[1]}%`;
        this.persist();
      }
    });
    const timeout = setTimeout(() => {
      owner.cancelled = true;
      killProcessGroup(child);
    }, 10 * 60_000);
    const code = await new Promise<number | null>((resolve) => {
      child.once('error', () => resolve(null));
      child.once('close', (code) => resolve(code));
    });
    clearTimeout(timeout);
    killProcessGroup(child);
    op.cleanupConfirmed = child.pid ? await processGroupGone(child.pid, timers) : true;
    return code === 0 && op.cleanupConfirmed && !owner.cancelled;
  }
  cancel(id: string) {
    const owner = this.live.get(id);
    if (owner) {
      owner.cancelled = true;
      if (owner.child) killProcessGroup(owner.child);
    }
    return this.get(id);
  }
  async wait(id: string) {
    await this.live.get(id)?.promise;
    return this.get(id);
  }
  async removePartial(id: string) {
    const op = this.operations.find((item) => item.id === id);
    if (!op || op.state === 'running' || op.state === 'completed' || !op.cleanupConfirmed)
      throw new Error(
        'The partial directory cannot be removed until process cleanup is confirmed.',
      );
    if (op.partialDirectory && existsSync(op.destination)) {
      // Check the exact reserved absolute directory again; never follow a replacement junction.
      const identity = lstatSync(op.destination, { bigint: true });
      if (
        identity.isSymbolicLink() ||
        `${identity.dev}:${identity.ino}` !== op.directoryIdentity ||
        realpathSync(op.destination) !== op.destination
      )
        throw new Error('The destination changed. Remove it manually after inspection.');
      await rm(op.destination, { recursive: true });
    }
    op.partialDirectory = false;
    this.persist();
    return this.get(id);
  }
  async close() {
    const pending = [...this.live.entries()];
    for (const [id] of pending) this.cancel(id);
    await Promise.allSettled(pending.map(([, owner]) => owner.promise));
  }
}
