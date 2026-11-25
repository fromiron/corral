import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type GhResult, parseGitHubRemote } from '../src/pull-requests/gh.ts';
import { type PullRequestDraftInput, PullRequestService } from '../src/pull-requests/service.ts';

// docs/specs/features/pull-requests.md: the PR row's facts, the draft and the open command, with
// real Git copies and an injected gh.

vi.setConfig({ testTimeout: 30000 });

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'corral-pr-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

type Call = { args: string[]; body?: string };

/** A repository whose origin is GitHub, a session copy on its own branch, and a fake gh. */
function fixture(options: { remote?: string; originHead?: boolean } = {}) {
  const root = temp();
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'one\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  git(root, 'remote', 'add', 'origin', options.remote ?? 'git@github.com:acme/widgets.git');
  git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  if (options.originHead !== false)
    git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const copy = join(temp(), 'copy');
  git(root, 'worktree', 'add', '-q', '-b', 'corral/login-fix-abc123', copy, 'HEAD');
  const commit = (name: string, subject: string) => {
    writeFileSync(join(copy, name), `${subject}\n`);
    git(copy, 'add', name);
    git(copy, 'commit', '-q', '-m', subject);
    return git(copy, 'rev-parse', 'HEAD');
  };
  const calls: Call[] = [];
  let prs: Record<string, unknown>[] = [];
  let gh: (args: string[]) => GhResult = (args) => {
    if (args[0] === 'pr' && args[1] === 'list') {
      const state = args[args.indexOf('--state') + 1];
      const listed = state === 'open' ? prs.filter((pr) => pr.state === 'OPEN') : prs;
      return { code: 0, stdout: JSON.stringify(listed) };
    }
    if (args[0] === 'pr' && args[1] === 'create') {
      const pr = {
        number: 12,
        url: 'https://github.com/acme/widgets/pull/12',
        state: 'OPEN',
        isDraft: false,
        title: args[args.indexOf('--title') + 1],
        headRefOid: git(copy, 'rev-parse', 'HEAD'),
        baseRefName: args[args.indexOf('--base') + 1],
        updatedAt: '2026-11-25T12:00:00Z',
        statusCheckRollup: [],
        reviewDecision: '',
        mergeable: 'MERGEABLE',
      };
      prs = [...prs, pr];
      return { code: 0, stdout: `${pr.url}\n` };
    }
    if (args[0] === 'repo' && args[1] === 'view')
      return { code: 0, stdout: JSON.stringify({ defaultBranchRef: { name: 'main' } }) };
    return { code: 1, stdout: '' };
  };
  const dataDir = temp();
  const drafter = vi.fn(
    async (
      _input: PullRequestDraftInput,
      _context: { signal: AbortSignal; operationId: string; sessionId: string },
    ) => null as { title: string; body: string } | null,
  );
  const service = new PullRequestService({
    copyOf: (sessionId) => (sessionId === 's1' ? { worktree: copy, root } : null),
    gh: async (args) => {
      const bodyFile = args.includes('--body-file') ? args[args.indexOf('--body-file') + 1] : null;
      calls.push({ args, ...(bodyFile ? { body: readFileSync(bodyFile, 'utf8') } : {}) });
      return gh(args);
    },
    draft: drafter,
    dataDir,
  });
  return {
    root,
    copy,
    commit,
    calls,
    service,
    drafter,
    dataDir,
    setPrs: (value: Record<string, unknown>[]) => {
      prs = value;
    },
    setGh: (fn: typeof gh) => {
      gh = fn;
    },
  };
}

const pr = (state: 'OPEN' | 'MERGED' | 'CLOSED', number: number, extra = {}) => ({
  number,
  url: `https://github.com/acme/widgets/pull/${number}`,
  state,
  isDraft: false,
  title: `PR ${number}`,
  headRefOid: '0'.repeat(40),
  baseRefName: 'main',
  updatedAt: `2026-11-2${number % 10}T00:00:00Z`,
  statusCheckRollup: [],
  reviewDecision: '',
  mergeable: 'UNKNOWN',
  ...extra,
});

describe('GitHub remotes', () => {
  it('reads owner and name from the three GitHub forms, and nothing else', () => {
    for (const url of [
      'https://github.com/acme/widgets.git',
      'https://github.com/acme/widgets',
      'git@github.com:acme/widgets.git',
      'ssh://git@github.com/acme/widgets.git',
    ])
      expect(parseGitHubRemote(url)).toEqual({ owner: 'acme', name: 'widgets' });
    for (const url of [
      'https://gitlab.com/acme/widgets.git',
      'https://github.example.com/acme/widgets.git',
      'https://github.com/acme',
      '/srv/git/widgets.git',
    ])
      expect(parseGitHubRemote(url)).toBeNull();
  });
});

describe('the PR row', () => {
  it('offers push and open for unpushed commits, and open once the branch is on the remote', async () => {
    const f = fixture();
    f.commit('b.txt', 'Fix the login check');
    expect(await f.service.view('s1', true)).toMatchObject({
      kind: 'none',
      branch: 'corral/login-fix-abc123',
      base: 'main',
      action: 'push_and_open',
      previous: null,
    });
    git(f.copy, 'update-ref', 'refs/remotes/origin/corral/login-fix-abc123', 'HEAD');
    expect(await f.service.view('s1', true)).toMatchObject({ kind: 'none', action: 'open' });
    git(f.copy, 'commit', '-q', '--allow-empty', '-m', 'local only');
    expect(await f.service.view('s1', true)).toMatchObject({ action: 'push_and_open' });
  });

  it('sends the person to Git when the remote branch is ahead', async () => {
    const f = fixture();
    const first = f.commit('b.txt', 'one');
    f.commit('c.txt', 'two');
    git(f.copy, 'update-ref', 'refs/remotes/origin/corral/login-fix-abc123', 'HEAD');
    git(f.copy, 'reset', '-q', '--hard', first);
    expect(await f.service.view('s1', true)).toMatchObject({ kind: 'none', action: 'sync' });
  });

  it('shows an open PR, with push when HEAD is ahead of its head commit', async () => {
    const f = fixture();
    const pushed = f.commit('b.txt', 'one');
    f.setPrs([
      pr('OPEN', 12, {
        headRefOid: pushed,
        statusCheckRollup: [
          { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
          { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
          { __typename: 'StatusContext', state: 'SUCCESS' },
        ],
        reviewDecision: 'CHANGES_REQUESTED',
        mergeable: 'CONFLICTING',
      }),
    ]);
    expect(await f.service.view('s1', true)).toMatchObject({
      kind: 'open',
      push: false,
      pr: {
        number: 12,
        state: 'open',
        checks: { passed: 2, failed: 1, pending: 1 },
        review: 'changes_requested',
        conflicting: true,
      },
    });
    f.commit('c.txt', 'two');
    expect(await f.service.view('s1', true)).toMatchObject({ kind: 'open', push: true });
  });

  it('offers a new PR after the last one merged, naming the merged one', async () => {
    const f = fixture();
    f.commit('b.txt', 'one');
    f.setPrs([pr('CLOSED', 3), pr('MERGED', 7)]);
    expect(await f.service.view('s1', true)).toMatchObject({
      kind: 'none',
      action: 'push_and_open',
      previous: { number: 7, state: 'merged' },
    });
  });

  it('has no row when nothing is ahead and no PR was ever opened', async () => {
    const f = fixture();
    expect(await f.service.view('s1', true)).toEqual({ kind: 'hidden', reason: 'nothing_to_open' });
  });

  it('names a missing or signed-out gh only when there is something to open', async () => {
    const f = fixture();
    f.setGh(() => ({ code: 'missing', stdout: '' }));
    expect(await f.service.view('s1', true)).toEqual({ kind: 'hidden', reason: 'nothing_to_open' });
    f.commit('b.txt', 'one');
    expect(await f.service.view('s1', true)).toEqual({ kind: 'gh_missing' });
    f.setGh(() => ({ code: 4, stdout: '' }));
    expect(await f.service.view('s1', true)).toEqual({ kind: 'gh_signed_out' });
    f.setGh(() => ({ code: 1, stdout: '' }));
    expect(await f.service.view('s1', true)).toEqual({ kind: 'read_failed' });
  });

  it('hides the row for a non-GitHub remote, a detached copy, the default branch or no Paddock', async () => {
    expect(
      await fixture({ remote: 'https://gitlab.com/acme/widgets.git' }).service.view('s1', true),
    ).toEqual({ kind: 'hidden', reason: 'not_github' });
    const detached = fixture();
    git(detached.copy, 'checkout', '-q', '--detach');
    expect(await detached.service.view('s1', true)).toEqual({ kind: 'hidden', reason: 'detached' });
    const onMain = fixture();
    git(onMain.copy, 'checkout', '-q', '-b', 'main-copy');
    git(onMain.root, 'checkout', '-q', '--detach');
    git(onMain.copy, 'checkout', '-q', 'main');
    expect(await onMain.service.view('s1', true)).toEqual({
      kind: 'hidden',
      reason: 'default_branch',
    });
    expect(await onMain.service.view('nobody', true)).toEqual({
      kind: 'hidden',
      reason: 'no_paddock',
    });
  });

  it('knows the repository by its configured URL, whatever insteadOf rewrites it to', async () => {
    const f = fixture({ remote: 'https://github.com/acme/widgets.git' });
    git(
      f.root,
      'config',
      'url./srv/mirror/widgets.git.insteadOf',
      'https://github.com/acme/widgets.git',
    );
    f.commit('b.txt', 'one');
    expect(await f.service.view('s1', true)).toMatchObject({ kind: 'none', base: 'main' });
  });

  it('reads the default branch with gh when origin/HEAD is unknown', async () => {
    const f = fixture({ originHead: false });
    f.commit('b.txt', 'one');
    expect(await f.service.view('s1', true)).toMatchObject({ base: 'main' });
    expect(f.calls.some((call) => call.args[0] === 'repo' && call.args[1] === 'view')).toBe(true);
  });

  it('keeps the last GitHub read for local reads, and runs gh only when asked', async () => {
    const f = fixture();
    const pushed = f.commit('b.txt', 'one');
    f.setPrs([pr('OPEN', 12, { headRefOid: pushed })]);
    await f.service.view('s1', true);
    const before = f.calls.filter((call) => call.args[0] === 'pr').length;
    f.commit('c.txt', 'two');
    expect(await f.service.view('s1', false)).toMatchObject({ kind: 'open', push: true });
    expect(f.calls.filter((call) => call.args[0] === 'pr').length).toBe(before);
  });

  it('passes the repository and never a working folder to gh', async () => {
    const f = fixture();
    f.commit('b.txt', 'one');
    await f.service.view('s1', true);
    const list = f.calls.find((call) => call.args[0] === 'pr' && call.args[1] === 'list');
    expect(list?.args).toEqual(
      expect.arrayContaining(['--repo', 'acme/widgets', '--head', 'corral/login-fix-abc123']),
    );
  });
});

describe('the draft', () => {
  it('falls back to the commit list without a model', async () => {
    const f = fixture();
    f.commit('b.txt', 'Add the check');
    const head = f.commit('c.txt', 'Fix the login check');
    expect(
      await f.service.draft('s1', {
        signal: new AbortController().signal,
        operationId: 'op_draft',
      }),
    ).toEqual({
      title: 'Fix the login check',
      body: '## Summary\n\n- Fix the login check\n- Add the check\n\n## Testing\n\nNot run',
      head: { branch: 'corral/login-fix-abc123', commit: head },
      base: 'main',
      source: 'commits',
    });
  });

  it("uses the model's text, first title line only, with local paths made relative", async () => {
    const f = fixture();
    f.commit('b.txt', 'one');
    f.drafter.mockResolvedValueOnce({
      title: 'Tighten the login check\nsecond line',
      body: `Changed ${join(f.copy, 'src/login.ts')} and ${join(f.root, 'README.md')}.`,
    });
    const draft = await f.service.draft('s1', {
      signal: new AbortController().signal,
      operationId: 'op_draft',
    });
    expect(draft).toMatchObject({
      title: 'Tighten the login check',
      body: 'Changed src/login.ts and README.md.',
      source: 'model',
    });
    const input = f.drafter.mock.calls[0]?.[0];
    expect(input).toMatchObject({ base: 'main', head: 'corral/login-fix-abc123' });
    expect(input?.commits).toContain('one');
  });
});

describe('opening', () => {
  it('opens with the reviewed title and body, from a body file it removes', async () => {
    const f = fixture();
    const head = f.commit('b.txt', 'one');
    const opened = await f.service.open('s1', {
      operationId: 'op_open_1',
      title: 'Fix the login check',
      body: 'Body text',
      head: { branch: 'corral/login-fix-abc123', commit: head },
    });
    expect(opened).toMatchObject({ ok: true, pr: { number: 12, state: 'open' } });
    const create = f.calls.find((call) => call.args[1] === 'create');
    expect(create?.args).toEqual(
      expect.arrayContaining([
        '--repo',
        'acme/widgets',
        '--head',
        'corral/login-fix-abc123',
        '--base',
        'main',
        '--title',
        'Fix the login check',
      ]),
    );
    expect(create?.body).toBe('Body text');
    expect(readdirSync(f.dataDir)).toEqual([]);
  });

  it('refuses when the branch moved since the dialog opened', async () => {
    const f = fixture();
    const head = f.commit('b.txt', 'one');
    f.commit('c.txt', 'two');
    expect(
      await f.service.open('s1', {
        operationId: 'op_open_2',
        title: 't',
        body: '',
        head: { branch: 'corral/login-fix-abc123', commit: head },
      }),
    ).toMatchObject({ ok: false, code: 'REVISION_CONFLICT' });
    expect(f.calls.some((call) => call.args[1] === 'create')).toBe(false);
  });

  it('returns the open PR instead of opening a second one, and repeats a settled result', async () => {
    const f = fixture();
    const head = f.commit('b.txt', 'one');
    f.setPrs([pr('OPEN', 9, { headRefOid: head })]);
    const request = {
      operationId: 'op_open_3',
      title: 't',
      body: '',
      head: { branch: 'corral/login-fix-abc123', commit: head },
    };
    expect(await f.service.open('s1', request)).toMatchObject({ ok: true, pr: { number: 9 } });
    expect(f.calls.some((call) => call.args[1] === 'create')).toBe(false);
    f.setPrs([]);
    expect(await f.service.open('s1', request)).toMatchObject({ ok: true, pr: { number: 9 } });
  });

  it('reports an unknown outcome when gh does not finish', async () => {
    const f = fixture();
    const head = f.commit('b.txt', 'one');
    f.setGh((args) =>
      args[1] === 'create' ? { code: 'timeout', stdout: '' } : { code: 0, stdout: '[]' },
    );
    expect(
      await f.service.open('s1', {
        operationId: 'op_open_4',
        title: 't',
        body: '',
        head: { branch: 'corral/login-fix-abc123', commit: head },
      }),
    ).toMatchObject({ ok: false, code: 'REQUEST_OUTCOME_UNKNOWN' });
    expect(existsSync(f.dataDir) && readdirSync(f.dataDir)).toEqual([]);
  });
});
