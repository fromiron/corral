import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { openDatabase } from '@corral/storage-sqlite';
import { FakeClock, ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type FffFinder,
  type FffInitOptions,
  type FffMixedItem,
  type FffModule,
  FffPathEngine,
  type FffResult,
} from '../src/files/path-engine.ts';
import { WorkspaceService } from '../src/files/service.ts';
import { startCorralServer } from '../src/index.ts';

// FFF ranks path search; the built-in scope decides what may be offered. Every case injects
// the FFF module, the clock and the data directory: no native module loads here.
vi.setConfig({ testTimeout: 30000 });

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'corral-paths-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const file = (relativePath: string): FffMixedItem => ({ type: 'file', item: { relativePath } });
const dir = (relativePath: string): FffMixedItem => ({ type: 'directory', item: { relativePath } });

/** A stand-in for @ff-labs/fff-node that records what Corral asks of it. */
function fakeFff(
  behaviour: {
    results?: (query: string, root: string) => FffMixedItem[] | FffResult<never>;
    destroy?: (root: string) => void;
    binary?: boolean;
  } = {},
) {
  const created: FffInitOptions[] = [];
  const destroyed: string[] = [];
  const searches: { root: string; query: string; pageSize?: number }[] = [];
  const module: FffModule = {
    binaryExists: () => behaviour.binary ?? true,
    FileFinder: {
      ensureLoaded: () => {},
      create: (init) => {
        created.push(init);
        const finder: FffFinder = {
          mixedSearch: (query, options) => {
            searches.push({ root: init.basePath, query, pageSize: options?.pageSize });
            const found = behaviour.results?.(query, init.basePath) ?? [];
            return Array.isArray(found) ? { ok: true, value: { items: found } } : found;
          },
          destroy: () => {
            behaviour.destroy?.(init.basePath);
            destroyed.push(init.basePath);
          },
        };
        return { ok: true, value: finder };
      },
    },
  };
  return { module, created, destroyed, searches, load: async () => module };
}

async function setup(
  engine?: (clock: FakeClock, dataDir: string) => FffPathEngine,
  prepare?: (root: string, git: (...args: string[]) => void) => void,
) {
  const original = temp();
  const git = (...args: string[]) => {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
      cwd: original,
    });
  };
  git('init', '-q');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(original, 'a.txt'), 'one\n');
  prepare?.(original, git);
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  const db = openDatabase(':memory:');
  db.prepare(
    "INSERT INTO work_sessions (id, project_id, corral_id, title, objective, pinned, revision, created_at, updated_at, archived_at, entries_json) VALUES ('session_1', 'default', NULL, 't', '', 0, 1, 'x', 'x', NULL, '[]')",
  ).run();
  const clock = new FakeClock();
  const dataDir = join(temp(), 'data', 'path-search');
  const pathEngine = engine?.(clock, dataDir);
  const service = new WorkspaceService({
    db,
    clock,
    worktreeRoot: join(temp(), 'worktrees'),
    forbidden: [],
    ...(pathEngine ? { pathEngine } : {}),
  });
  await service.bind('default', original);
  await service.configure('default', { trusted: true });
  const project = { kind: 'project' as const, id: 'default' };
  const session = { kind: 'session' as const, id: 'session_1' };
  const close = async () => {
    await service.dispose();
    db.close();
  };
  return { db, service, original, clock, dataDir, project, session, close, pathEngine };
}

const paths = (found: { items: { path: string; kind: string }[] }) =>
  found.items.map((item) => `${item.kind}:${item.path}`);

describe('FFF path ranking inside the built-in scope', () => {
  it('drops FFF results the built-in scope would not offer, and keeps tracked ignored files', async () => {
    const fff = fakeFff({
      results: () => [
        file('ignored/secret.ts'),
        file('outside/passwd'),
        file('outside'),
        file('.corral/records.json'),
        file('.git/config'),
        file('../escape.ts'),
        file('/etc/passwd'),
        file('src/kept.ts'),
        file('build/tracked.txt'),
        dir('ignored/'),
        dir('src/'),
      ],
    });
    const s = await setup(
      (clock, dataDir) => new FffPathEngine({ load: fff.load, clock, dataDir }),
      (root, git) => {
        mkdirSync(join(root, 'src'));
        writeFileSync(join(root, 'src', 'kept.ts'), 'x');
        mkdirSync(join(root, 'build'));
        writeFileSync(join(root, 'build', 'tracked.txt'), 'x');
        git('add', '.');
        git('commit', '-q', '-m', 'tracked build output');
        // Ignored after it was committed: Git still lists it, so the built-in offers it.
        writeFileSync(join(root, '.gitignore'), 'build/\nignored/\n');
        mkdirSync(join(root, 'ignored'));
        writeFileSync(join(root, 'ignored', 'secret.ts'), 'x');
        mkdirSync(join(root, '.corral'));
        writeFileSync(join(root, '.corral', 'records.json'), '{}');
        symlinkSync('/etc', join(root, 'outside'));
      },
    );
    try {
      const found = await s.service.searchPaths(s.project, 'zzzz', 10);
      expect(paths(found)).toEqual(['file:src/kept.ts', 'file:build/tracked.txt', 'folder:src']);
      expect(fff.searches[0]).toMatchObject({ query: 'zzzz' });
      expect(await s.service.pathEngineStatus()).toEqual({ engine: 'fff' });
    } finally {
      await s.close();
    }
  });

  it('finds a tracked but ignored file the FFF index missed, as the built-in engine does', async () => {
    const fff = fakeFff({ results: () => [] });
    const s = await setup(
      (clock, dataDir) => new FffPathEngine({ load: fff.load, clock, dataDir }),
      (root, git) => {
        mkdirSync(join(root, 'build'));
        writeFileSync(join(root, 'build', 'tracked.txt'), 'x');
        git('add', '.');
        git('commit', '-q', '-m', 'tracked build output');
        writeFileSync(join(root, '.gitignore'), 'build/\n');
      },
    );
    try {
      const found = await s.service.searchPaths(s.project, 'tracked', 10);
      expect(paths(found)).toContain('file:build/tracked.txt');
    } finally {
      await s.close();
    }
  });

  it('fills from the built-in ranking without duplicates when FFF returns fewer than the limit', async () => {
    const fff = fakeFff({ results: () => [file('src/alpha-2.ts'), file('src/alpha-2.ts')] });
    const s = await setup(
      (clock, dataDir) => new FffPathEngine({ load: fff.load, clock, dataDir }),
      (root) => {
        mkdirSync(join(root, 'src'));
        for (const name of ['alpha-1.ts', 'alpha-2.ts', 'alpha-3.ts', 'alpha-4.ts'])
          writeFileSync(join(root, 'src', name), 'x');
      },
    );
    try {
      const found = await s.service.searchPaths(s.project, 'alpha', 4);
      const listed = paths(found);
      expect(listed[0]).toBe('file:src/alpha-2.ts');
      expect(listed).toHaveLength(4);
      expect(new Set(listed).size).toBe(4);
    } finally {
      await s.close();
    }
  });
});

describe('the built-in fallback', () => {
  it('uses only the built-in engine and reports loadFailed when the native module does not load', async () => {
    const s = await setup((clock, dataDir) => {
      return new FffPathEngine({
        load: async () => {
          throw new Error('libfff_c.so: cannot open shared object file');
        },
        clock,
        dataDir,
      });
    });
    try {
      const found = await s.service.searchPaths(s.project, 'a', 5);
      expect(paths(found)).toEqual(['file:a.txt']);
      expect(await s.service.pathEngineStatus()).toEqual({
        engine: 'builtIn',
        reason: 'loadFailed',
      });
    } finally {
      await s.close();
    }
  });

  it('reports noBinary when the module has no binary for this platform', async () => {
    const fff = fakeFff({ binary: false });
    const s = await setup(
      (clock, dataDir) => new FffPathEngine({ load: fff.load, clock, dataDir }),
    );
    try {
      expect(paths(await s.service.searchPaths(s.project, 'a', 5))).toEqual(['file:a.txt']);
      expect(fff.created).toEqual([]);
      expect(await s.service.pathEngineStatus()).toEqual({ engine: 'builtIn', reason: 'noBinary' });
    } finally {
      await s.close();
    }
  });

  it('reports a plain built-in engine when no FFF module is configured', async () => {
    const s = await setup();
    try {
      expect(await s.service.pathEngineStatus()).toEqual({ engine: 'builtIn' });
    } finally {
      await s.close();
    }
  });

  it('uses the built-in results and reports timeBudget when an FFF query runs over its budget', async () => {
    let clock: FakeClock | undefined;
    const fff = fakeFff({
      results: () => {
        clock?.advance(5_000);
        return [file('zzz.txt')];
      },
    });
    const s = await setup(
      (fake, dataDir) => {
        clock = fake;
        return new FffPathEngine({ load: fff.load, clock: fake, dataDir, budgetMs: 100 });
      },
      (root) => writeFileSync(join(root, 'zzz.txt'), 'x'),
    );
    try {
      const found = await s.service.searchPaths(s.project, 'a', 5);
      expect(paths(found)).toEqual(['file:a.txt']);
      expect(await s.service.pathEngineStatus()).toEqual({
        engine: 'builtIn',
        reason: 'timeBudget',
      });
    } finally {
      await s.close();
    }
  });

  it('uses the built-in results and reports callFailed when an FFF query fails', async () => {
    const fff = fakeFff({ results: () => ({ ok: false, error: 'index poisoned' }) });
    const s = await setup(
      (clock, dataDir) => new FffPathEngine({ load: fff.load, clock, dataDir }),
    );
    try {
      expect(paths(await s.service.searchPaths(s.project, 'a', 5))).toEqual(['file:a.txt']);
      expect(await s.service.pathEngineStatus()).toEqual({
        engine: 'builtIn',
        reason: 'callFailed',
      });
    } finally {
      await s.close();
    }
  });

  it('reports indexCap and opens no index when the scope listing was cut short', async () => {
    const fff = fakeFff({ results: () => [file('a.txt')] });
    const s = await setup(
      (clock, dataDir) => new FffPathEngine({ load: fff.load, clock, dataDir }),
    );
    try {
      // A folder that is not a Git repository is walked, and the walk stops at 500 files.
      const plain = temp();
      for (let i = 0; i < 520; i++) writeFileSync(join(plain, `note-${i}.txt`), 'x');
      s.db.prepare('UPDATE workspace_bindings SET root_path = ?, is_git = 0').run(plain);
      const found = await s.service.searchPaths(s.project, 'note', 5);
      expect(found.items).toHaveLength(5);
      expect(fff.created).toEqual([]);
      expect(await s.service.pathEngineStatus()).toEqual({ engine: 'builtIn', reason: 'indexCap' });
    } finally {
      await s.close();
    }
  });
});

describe('late results', () => {
  it('drops the results of a query whose copy was replaced while it ran', async () => {
    let switchTarget = () => {};
    const fff = fakeFff({
      results: () => {
        switchTarget();
        return [file('a.txt')];
      },
    });
    const s = await setup(
      (clock, dataDir) => new FffPathEngine({ load: fff.load, clock, dataDir }),
    );
    try {
      await s.service.createWorktree('session_1', 'default');
      switchTarget = () => {
        s.db
          .prepare(
            "UPDATE session_worktrees SET copy_generation = copy_generation + 1 WHERE session_id = 'session_1'",
          )
          .run();
      };
      await expect(s.service.searchPaths(s.session, 'a', 5)).rejects.toMatchObject({
        code: 'REVISION_CONFLICT',
      });
      // The next query searches the new generation with its own index.
      switchTarget = () => {};
      expect(paths(await s.service.searchPaths(s.session, 'a', 5))).toEqual(['file:a.txt']);
      expect(fff.created).toHaveLength(2);
    } finally {
      await s.close();
    }
  });

  it('drops the results of a cancelled query', async () => {
    const cancel = new AbortController();
    const fff = fakeFff({
      results: () => {
        cancel.abort();
        return [file('a.txt')];
      },
    });
    const s = await setup(
      (clock, dataDir) => new FffPathEngine({ load: fff.load, clock, dataDir }),
    );
    try {
      await expect(s.service.searchPaths(s.project, 'a', 5, cancel.signal)).rejects.toMatchObject({
        code: 'TARGET_TERMINAL',
      });
    } finally {
      await s.close();
    }
  });
});

describe('index lifetime', () => {
  it('closes the least recently used index at the cap', async () => {
    const fff = fakeFff();
    const engine = new FffPathEngine({
      load: fff.load,
      clock: new FakeClock(),
      dataDir: join(temp(), 'path-search'),
      maxIndexes: 2,
    });
    await engine.ready();
    engine.query({ key: 'a', root: '/fake/a' }, 'x', 10, true);
    engine.query({ key: 'b', root: '/fake/b' }, 'x', 10, true);
    engine.query({ key: 'a', root: '/fake/a' }, 'x', 10, true);
    engine.query({ key: 'c', root: '/fake/c' }, 'x', 10, true);
    expect(fff.destroyed).toEqual(['/fake/b']);
    engine.query({ key: 'b', root: '/fake/b' }, 'x', 10, true);
    expect(fff.destroyed).toEqual(['/fake/b', '/fake/a']);
    expect(fff.created.map((init) => init.basePath)).toEqual([
      '/fake/a',
      '/fake/b',
      '/fake/c',
      '/fake/b',
    ]);
    engine.dispose();
    expect(fff.destroyed.slice(2).sort()).toEqual(['/fake/b', '/fake/c']);
  });

  it('closes the index before the copy is removed', async () => {
    let existedAtDestroy: boolean | undefined;
    const fff = fakeFff({ destroy: (root) => (existedAtDestroy = existsSync(root)) });
    const s = await setup(
      (clock, dataDir) => new FffPathEngine({ load: fff.load, clock, dataDir }),
    );
    try {
      await s.service.createWorktree('session_1', 'default');
      const copy = s.service.copyOf('session_1')?.worktree as string;
      await s.service.searchPaths(s.session, 'a', 5);
      expect(fff.created.map((init) => init.basePath)).toEqual([copy]);
      await s.service.removeWorktree('session_1');
      expect(fff.destroyed).toEqual([copy]);
      expect(existedAtDestroy).toBe(true);
      expect(existsSync(copy)).toBe(false);
    } finally {
      await s.close();
    }
  });

  it('removes the copy when closing its index fails, and falls back to the built-in engine', async () => {
    const fff = fakeFff({
      results: () => [file('a.txt')],
      destroy: () => {
        throw new Error('destroy failed');
      },
    });
    const s = await setup(
      (clock, dataDir) => new FffPathEngine({ load: fff.load, clock, dataDir }),
    );
    try {
      await s.service.createWorktree('session_1', 'default');
      const copy = s.service.copyOf('session_1')?.worktree as string;
      await s.service.searchPaths(s.session, 'a', 5);
      await s.service.removeWorktree('session_1');
      expect(existsSync(copy)).toBe(false);
      expect(s.service.copyOf('session_1')).toBeNull();
      expect(await s.service.pathEngineStatus()).toEqual({
        engine: 'builtIn',
        reason: 'callFailed',
      });
      expect(paths(await s.service.searchPaths(s.project, 'a', 5))).toEqual(['file:a.txt']);
      expect(fff.created).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  it('closes every open index at shutdown', async () => {
    const fff = fakeFff();
    const s = await setup(
      (clock, dataDir) => new FffPathEngine({ load: fff.load, clock, dataDir }),
    );
    await s.service.createWorktree('session_1', 'default');
    await s.service.searchPaths(s.session, 'a', 5);
    await s.service.searchPaths(s.project, 'a', 5);
    expect(fff.created).toHaveLength(2);
    await s.close();
    expect([...fff.destroyed].sort()).toEqual(fff.created.map((init) => init.basePath).sort());
  });
});

describe('what FFF keeps and says', () => {
  it('keeps its frecency database inside the data directory and logs no paths', async () => {
    const written: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(' '));
      });
    for (const stream of [process.stdout, process.stderr])
      vi.spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    let root = '';
    const fff = fakeFff({
      results: (_query, basePath) => {
        root = basePath;
        return { ok: false, error: `cannot read ${basePath}/a.txt` };
      },
    });
    const s = await setup(
      (clock, dataDir) => new FffPathEngine({ load: fff.load, clock, dataDir }),
    );
    try {
      await s.service.searchPaths(s.project, 'a', 5);
      const [init] = fff.created;
      expect(init?.basePath).toBe(s.original);
      const inside = relative(s.dataDir, init?.frecencyDbPath ?? '/');
      expect(inside === '' || inside.startsWith('..') || isAbsolute(inside)).toBe(false);
      expect(init).not.toHaveProperty('logFilePath');
      expect(init).not.toHaveProperty('historyDbPath');
      expect(init?.followSymlinks).toBe(false);
      const status = JSON.stringify(await s.service.pathEngineStatus());
      for (const path of [root, s.original, s.dataDir]) {
        expect(status).not.toContain(path);
        for (const line of written) expect(line).not.toContain(path);
      }
    } finally {
      await s.close();
    }
  });

  it('reports the path engine on the server health check without paths', async () => {
    const workspace = temp();
    const server = await startCorralServer({
      workspace,
      port: 0,
      agents: new ScriptedAgentAdapter({ turns: 1 }),
      worktreeRoot: join(temp(), 'worktrees'),
      fff: async () => {
        throw new Error(`cannot load ${workspace}/libfff_c.so`);
      },
    });
    try {
      const body = await (await fetch(`${server.url}/api/v1/health`)).json();
      expect(body.pathEngine).toEqual({ engine: 'builtIn', reason: 'loadFailed' });
      expect(JSON.stringify(body)).not.toContain(workspace);
    } finally {
      await server.close();
    }
    const plain = await startCorralServer({
      workspace: temp(),
      port: 0,
      agents: new ScriptedAgentAdapter({ turns: 1 }),
      worktreeRoot: join(temp(), 'worktrees'),
    });
    try {
      const body = await (await fetch(`${plain.url}/api/v1/health`)).json();
      expect(body.pathEngine).toEqual({ engine: 'builtIn' });
    } finally {
      await plain.close();
    }
  });
});
