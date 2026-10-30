import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Bundle } from '../src/bundle.ts';
import type { HelperCommand, HelperLauncher, HelperProcess } from '../src/engine/helper.ts';
import { bundleDir } from '../src/install.ts';

export interface SentRequest {
  id: number;
  texts: string[];
  overflow: string;
  dim: number;
}

/** An in-memory helper the test drives: it answers only when told to. */
export class FakeHelper implements HelperProcess {
  readonly sent: SentRequest[] = [];
  killed = false;
  private lineHandlers: ((line: string) => void)[] = [];
  private exitHandlers: ((detail: string) => void)[] = [];
  private exited = false;
  readonly command: HelperCommand;
  constructor(command: HelperCommand) {
    this.command = command;
  }

  write(line: string) {
    if (this.exited) throw new Error('helper stdin is closed');
    this.sent.push(JSON.parse(line) as SentRequest);
  }
  onLine(fn: (line: string) => void) {
    this.lineHandlers.push(fn);
  }
  onExit(fn: (detail: string) => void) {
    this.exitHandlers.push(fn);
  }
  async kill() {
    this.killed = true;
    this.exit('killed');
  }

  get backend() {
    return this.command.args[this.command.args.indexOf('--backend') + 1];
  }
  private emit(message: unknown) {
    for (const fn of this.lineHandlers) fn(JSON.stringify(message));
  }
  ready() {
    this.emit({ type: 'ready', api: [1, 0, 0], backend: this.backend });
  }
  fatal(message: string) {
    this.emit({ type: 'fatal', message });
    this.exit(message);
  }
  /** Answers request `index` (default: the last sent) with one vector per text. */
  answer(index = this.sent.length - 1, fill = 0.5) {
    const request = this.sent[index]!;
    this.emit({
      type: 'result',
      id: request.id,
      embeddings: request.texts.map(() => Array.from({ length: request.dim }, () => fill)),
    });
  }
  error(index = this.sent.length - 1, message = 'bad input') {
    this.emit({ type: 'error', id: this.sent[index]!.id, message });
  }
  exit(detail: string) {
    if (this.exited) return;
    this.exited = true;
    for (const fn of this.exitHandlers) fn(detail);
  }
}

export function fakeLauncher() {
  const helpers: FakeHelper[] = [];
  const launch: HelperLauncher = (command) => {
    const helper = new FakeHelper(command);
    helpers.push(helper);
    return helper;
  };
  return { launch, helpers, last: () => helpers[helpers.length - 1]! };
}

/** A manual clock: `after` callbacks run only when the test advances time. */
export class ManualClock {
  time = 1_000_000;
  private timers: { at: number; fn: () => void; live: boolean }[] = [];
  now = () => this.time;
  after = (ms: number, fn: () => void) => {
    const timer = { at: this.time + ms, fn, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  };
  advance(ms: number) {
    this.time += ms;
    for (const timer of [...this.timers])
      if (timer.live && timer.at <= this.time) {
        timer.live = false;
        timer.fn();
      }
  }
}

/** Writes a stamp so the bundle reads as installed for linux-x64. */
export function markInstalled(root: string, bundle: Bundle) {
  const dir = bundleDir(root, bundle);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'install.json'),
    JSON.stringify({ release: bundle.release, target: 'linux-x64' }),
  );
}

export const flush = () => new Promise((resolve) => setImmediate(resolve));
