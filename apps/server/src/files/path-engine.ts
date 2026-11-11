import { mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Clock } from '@corral/contracts';

// FFF (@ff-labs/fff-node) ranks path search when it loads; the caller still decides which paths
// may be offered. Its calls run synchronously on the JS thread, so each query has a time budget,
// and every failure leaves the built-in engine answering with the reason kept for Diagnostics.
// Nothing here logs: FFF writes no log file, and reasons are codes without paths.

/** Why path search answers with the built-in engine although FFF was configured. */
export type PathEngineFallback =
  | 'loadFailed'
  | 'noBinary'
  | 'indexCap'
  | 'callFailed'
  | 'timeBudget';
export interface PathEngineStatus {
  engine: 'fff' | 'builtIn';
  reason?: PathEngineFallback;
}

export type FffResult<T> = { ok: true; value: T } | { ok: false; error: string };
/** The options of `FileFinder.create` this server sets; it never sets a log file. */
export interface FffInitOptions {
  basePath: string;
  frecencyDbPath?: string;
  disableMmapCache?: boolean;
  disableContentIndexing?: boolean;
  followSymlinks?: boolean;
}
export type FffMixedItem =
  | { type: 'file'; item: { relativePath: string } }
  | { type: 'directory'; item: { relativePath: string } };
export interface FffFinder {
  mixedSearch(query: string, options?: { pageSize?: number }): FffResult<{ items: FffMixedItem[] }>;
  destroy(): void;
}
/** The part of @ff-labs/fff-node the server uses; tests pass a fake. */
export interface FffModule {
  binaryExists(): boolean;
  FileFinder: { ensureLoaded(): void; create(options: FffInitOptions): FffResult<FffFinder> };
}

/** The real native module, resolved from the server package. */
export const loadFff = (): Promise<FffModule> => import('@ff-labs/fff-node');

export interface PathHit {
  path: string;
  kind: 'file' | 'folder';
}

/** Open indexes at once; the least recently used one closes first. */
const MAX_INDEXES = 4;
/** One query's FFF work (opening its index and searching) on the JS thread. */
const BUDGET_MS = 100;

export class FffPathEngine {
  private readonly load: () => Promise<FffModule>;
  private readonly clock: Clock;
  private readonly dataDir: string;
  private readonly maxIndexes: number;
  private readonly budgetMs: number;
  private loading: Promise<void> | null = null;
  private module: FffModule | null = null;
  /** A reason that holds for the rest of this process: the module, or a failed close. */
  private disabled: PathEngineFallback | null = null;
  /** The outcome of the latest query. */
  private last: PathEngineFallback | null = null;
  /** Insertion order is recency: the first entry is the least recently used. */
  private readonly indexes = new Map<string, { root: string; finder: FffFinder }>();

  constructor(options: {
    load: () => Promise<FffModule>;
    clock: Clock;
    /** Inside Corral's data directory; it holds the frecency database. */
    dataDir: string;
    maxIndexes?: number;
    budgetMs?: number;
  }) {
    this.load = options.load;
    this.clock = options.clock;
    this.dataDir = options.dataDir;
    this.maxIndexes = Math.max(1, options.maxIndexes ?? MAX_INDEXES);
    this.budgetMs = options.budgetMs ?? BUDGET_MS;
  }

  /** Loads the native module once. Never throws: a failure is kept as the reason. */
  ready(): Promise<void> {
    this.loading ??= (async () => {
      let module: FffModule;
      try {
        module = await this.load();
      } catch {
        this.disabled = 'loadFailed';
        return;
      }
      try {
        // An unsupported platform throws here instead of answering false.
        if (!module.binaryExists()) {
          this.disabled = 'noBinary';
          return;
        }
      } catch {
        this.disabled = 'noBinary';
        return;
      }
      try {
        module.FileFinder.ensureLoaded();
        mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      } catch {
        this.disabled = 'loadFailed';
        return;
      }
      this.module = module;
    })();
    return this.loading;
  }

  status(): PathEngineStatus {
    const reason = this.disabled ?? this.last;
    if (reason) return { engine: 'builtIn', reason };
    // Not loaded yet: what the next query will try.
    return { engine: 'fff' };
  }

  /**
   * FFF's ranked paths for one target, or null when the built-in engine must answer alone. A
   * target is one index: a copy generation or a source folder. `complete` says the caller listed
   * the whole scope; FFF results can only be checked against a complete one.
   */
  query(
    target: { key: string; root: string },
    query: string,
    pageSize: number,
    complete: boolean,
  ): PathHit[] | null {
    const module = this.module;
    if (this.disabled || !module) return null;
    if (!complete) {
      this.close(target.key);
      this.last = 'indexCap';
      return null;
    }
    const started = this.clock.monotonicMs();
    const finder = this.open(module, target);
    if (!finder) {
      this.last = 'callFailed';
      return null;
    }
    let found: FffResult<{ items: FffMixedItem[] }>;
    try {
      found = finder.mixedSearch(query, { pageSize });
    } catch {
      found = { ok: false, error: '' };
    }
    if (!found.ok) {
      // A failed index is not trusted again; the next query opens a new one.
      this.close(target.key);
      this.last = 'callFailed';
      return null;
    }
    if (this.clock.monotonicMs() - started > this.budgetMs) {
      this.last = 'timeBudget';
      return null;
    }
    this.last = null;
    const hits: PathHit[] = [];
    for (const entry of found.value.items) {
      let path = entry.item.relativePath;
      if (sep === '\\') path = path.replaceAll('\\', '/');
      if (entry.type === 'directory') path = path.replace(/\/+$/, '');
      if (path) hits.push({ path, kind: entry.type === 'file' ? 'file' : 'folder' });
    }
    return hits;
  }

  /** Closes a target's index. Never throws; a failed close leaves the built-in engine in use. */
  close(key: string) {
    const entry = this.indexes.get(key);
    if (!entry) return;
    this.indexes.delete(key);
    try {
      entry.finder.destroy();
    } catch {
      this.disabled = 'callFailed';
    }
  }

  dispose() {
    for (const key of [...this.indexes.keys()]) this.close(key);
  }

  private open(module: FffModule, target: { key: string; root: string }): FffFinder | null {
    const open = this.indexes.get(target.key);
    if (open && open.root === target.root) {
      this.indexes.delete(target.key);
      this.indexes.set(target.key, open);
      return open.finder;
    }
    this.close(target.key);
    while (this.indexes.size >= this.maxIndexes) {
      const oldest = this.indexes.keys().next().value as string;
      this.close(oldest);
    }
    if (this.disabled) return null;
    let created: FffResult<FffFinder>;
    try {
      created = module.FileFinder.create({
        basePath: target.root,
        // One database for every index, inside Corral's data; FFF shares it across instances.
        frecencyDbPath: join(this.dataDir, 'frecency'),
        // Path search only: no content cache, and the symbolic links the caller refuses anyway.
        disableMmapCache: true,
        disableContentIndexing: true,
        followSymlinks: false,
      });
    } catch {
      return null;
    }
    if (!created.ok) return null;
    this.indexes.set(target.key, { root: target.root, finder: created.value });
    return created.value;
  }
}
