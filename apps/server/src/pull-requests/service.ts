import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ErrorCode,
  OpenPullRequest,
  PullRequestDraft,
  PullRequestSummary,
  PullRequestView,
} from '@corral/contracts';
import { git, gitText } from '../files/git.ts';
import { type GhResult, type GhRunner, parseGitHubRemote } from './gh.ts';

export interface PullRequestDraftInput {
  base: string;
  head: string;
  commits: string;
  diffStat: string;
  diff: string;
}

export interface PullRequestDeps {
  copyOf(sessionId: string): { worktree: string; root: string } | null;
  gh: GhRunner;
  /** The model's title and body, or null when no model could write them. */
  draft(
    input: PullRequestDraftInput,
    context: { signal: AbortSignal; operationId: string; sessionId: string },
  ): Promise<{ title: string; body: string } | null>;
  dataDir: string;
}

export type OpenResult =
  | { ok: true; pr: PullRequestSummary }
  | { ok: false; code: ErrorCode; message: string };

interface RawPr {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  title: string;
  headRefOid: string;
  baseRefName: string;
  updatedAt: string;
  statusCheckRollup?: {
    __typename?: string;
    status?: string;
    conclusion?: string;
    state?: string;
  }[];
  reviewDecision?: string;
  mergeable?: string;
}

const FIELDS =
  'number,url,state,isDraft,title,headRefOid,baseRefName,updatedAt,statusCheckRollup,reviewDecision,mergeable';
const FAILED = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'ERROR',
]);
const PENDING = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED']);

type Failure = Extract<PullRequestView, { kind: 'gh_missing' | 'gh_signed_out' | 'read_failed' }>;
const failure = (result: GhResult): Failure =>
  result.code === 'missing'
    ? { kind: 'gh_missing' }
    : result.code === 4
      ? { kind: 'gh_signed_out' }
      : { kind: 'read_failed' };

export function summarize(raw: RawPr): PullRequestSummary {
  const rollup = raw.statusCheckRollup ?? [];
  const checks = { passed: 0, failed: 0, pending: 0 };
  for (const check of rollup) {
    const outcome = (check.conclusion || check.state || '').toUpperCase();
    const status = (check.status ?? '').toUpperCase();
    if (FAILED.has(outcome)) checks.failed += 1;
    else if ((status && status !== 'COMPLETED') || PENDING.has(outcome)) checks.pending += 1;
    else checks.passed += 1;
  }
  const review = raw.reviewDecision?.toLowerCase();
  return {
    number: raw.number,
    url: raw.url,
    title: raw.title,
    state: raw.state === 'MERGED' ? 'merged' : raw.state === 'CLOSED' ? 'closed' : 'open',
    isDraft: raw.isDraft,
    checks: rollup.length ? checks : null,
    review:
      review === 'approved' || review === 'changes_requested' || review === 'review_required'
        ? review
        : null,
    conflicting: raw.mergeable === 'CONFLICTING',
  };
}

const exists = (cwd: string, ref: string) =>
  git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then(
    () => true,
    () => false,
  );
const count = async (cwd: string, range: string) =>
  Number(await gitText(cwd, ['rev-list', '--count', range]));

interface Local {
  worktree: string;
  root: string;
  repo: string;
  branch: string;
  head: string;
  base: string;
  baseRef: string | null;
}

export class PullRequestService {
  private readonly deps: PullRequestDeps;
  private readonly remote = new Map<string, { branch: string; prs: RawPr[] }>();
  private readonly defaults = new Map<string, string>();
  private readonly opened = new Map<string, OpenResult>();

  constructor(deps: PullRequestDeps) {
    this.deps = deps;
  }

  async view(sessionId: string, readRemote: boolean): Promise<PullRequestView> {
    const local = await this.local(sessionId);
    if ('kind' in local) return local;
    const ahead = local.baseRef ? await count(local.worktree, `${local.baseRef}..HEAD`) : 1;
    let prs: RawPr[] = [];
    if (readRemote) {
      const listed = await this.list(local, 'all');
      if (!Array.isArray(listed))
        return ahead > 0 ? listed : { kind: 'hidden', reason: 'nothing_to_open' };
      this.remote.set(sessionId, { branch: local.branch, prs: listed });
      prs = listed;
    } else {
      const kept = this.remote.get(sessionId);
      prs = kept?.branch === local.branch ? kept.prs : [];
    }
    const open = prs.find((pr) => pr.state === 'OPEN');
    if (open) {
      const push =
        open.headRefOid !== local.head &&
        (await git(local.worktree, ['merge-base', '--is-ancestor', open.headRefOid, 'HEAD']).then(
          () => true,
          () => false,
        ));
      return { kind: 'open', branch: local.branch, base: local.base, pr: summarize(open), push };
    }
    const latest = [...prs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const previous = latest ? summarize(latest) : null;
    const action = ahead > 0 ? await this.action(local) : null;
    if (!action && !previous) return { kind: 'hidden', reason: 'nothing_to_open' };
    return { kind: 'none', branch: local.branch, base: local.base, action, previous };
  }

  async draft(
    sessionId: string,
    request: { signal: AbortSignal; operationId: string },
  ): Promise<PullRequestDraft> {
    const local = await this.local(sessionId);
    if ('kind' in local) throw new Error('this session has no branch to open a pull request from');
    const range = local.baseRef ? `${local.baseRef}..HEAD` : 'HEAD~20..HEAD';
    const log = await gitText(local.worktree, ['log', '--format=%s%x1f%b%x1e', range]).catch(
      () => '',
    );
    const commits = log
      .split('\x1e')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [subject = '', body = ''] = entry.split('\x1f');
        return { subject: subject.trim(), body: body.trim() };
      });
    const diffRange = local.baseRef ? `${local.baseRef}...HEAD` : 'HEAD';
    const diffStat = await gitText(local.worktree, ['diff', '--stat', diffRange]).catch(() => '');
    const diff = await gitText(local.worktree, ['diff', diffRange]).catch(() => '');
    const head = { branch: local.branch, commit: local.head };
    const relative = (text: string) => {
      let out = text;
      for (const prefix of [local.worktree, local.root]) {
        out = out.split(`${prefix}/`).join('').split(prefix).join('.');
      }
      return out;
    };
    const written = await this.deps
      .draft(
        {
          base: local.base,
          head: local.branch,
          commits: commits
            .map((commit) => `- ${commit.subject}${commit.body ? `\n  ${commit.body}` : ''}`)
            .join('\n')
            .slice(0, 20_000),
          diffStat: diffStat.slice(0, 20_000),
          diff: diff.slice(0, 60_000),
        },
        { ...request, sessionId },
      )
      .catch(() => null);
    const title = written?.title.split('\n')[0]?.trim();
    if (written && title)
      return {
        title: relative(title),
        body: relative(written.body.trim()),
        head,
        base: local.base,
        source: 'model',
      };
    return {
      title: commits[0]?.subject ?? local.branch,
      body: `## Summary\n\n${commits.map((commit) => `- ${commit.subject}`).join('\n')}\n\n## Testing\n\nNot run`,
      head,
      base: local.base,
      source: 'commits',
    };
  }

  async open(sessionId: string, request: OpenPullRequest): Promise<OpenResult> {
    const settled = this.opened.get(request.operationId);
    if (settled) return settled;
    const local = await this.local(sessionId);
    if ('kind' in local)
      return { ok: false, code: 'TARGET_NOT_FOUND', message: 'no branch to open a PR from' };
    if (local.branch !== request.head.branch || local.head !== request.head.commit)
      return {
        ok: false,
        code: 'REVISION_CONFLICT',
        message: 'the branch moved since the dialog opened',
      };
    const settle = (result: OpenResult) => {
      this.opened.set(request.operationId, result);
      this.remote.delete(sessionId);
      return result;
    };
    const existing = await this.list(local, 'open');
    if (!Array.isArray(existing)) return refused(existing);
    const already = existing.find((pr) => pr.state === 'OPEN');
    if (already) return settle({ ok: true, pr: summarize(already) });
    await mkdir(this.deps.dataDir, { recursive: true, mode: 0o700 });
    const bodyFile = join(this.deps.dataDir, `pr-body-${randomUUID()}.md`);
    await writeFile(bodyFile, request.body, { mode: 0o600 });
    let created: GhResult;
    try {
      created = await this.deps.gh([
        'pr',
        'create',
        '--repo',
        local.repo,
        '--head',
        local.branch,
        '--base',
        local.base,
        '--title',
        request.title,
        '--body-file',
        bodyFile,
      ]);
    } finally {
      await rm(bodyFile, { force: true });
    }
    if (created.code === 'timeout')
      return {
        ok: false,
        code: 'REQUEST_OUTCOME_UNKNOWN',
        message: 'gh did not finish; read the branch again to see whether the PR opened',
      };
    if (created.code !== 0) {
      if (created.code === 'missing' || created.code === 4) return refused(failure(created));
      return {
        ok: false,
        code: 'POLICY_ERROR',
        message: (created.stderr ?? '').trim().split('\n')[0]?.slice(0, 300) || 'GitHub refused',
      };
    }
    const after = await this.list(local, 'open');
    const made = Array.isArray(after) ? after.find((pr) => pr.state === 'OPEN') : undefined;
    if (made) return settle({ ok: true, pr: summarize(made) });
    const url = created.stdout.trim().split('\n').at(-1) ?? '';
    const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
    if (!number)
      return { ok: false, code: 'REQUEST_OUTCOME_UNKNOWN', message: 'the new PR was not found' };
    return settle({
      ok: true,
      pr: {
        number,
        url,
        title: request.title,
        state: 'open',
        isDraft: false,
        checks: null,
        review: null,
        conflicting: false,
      },
    });
  }

  private async action(local: Local) {
    const tracking = `refs/remotes/origin/${local.branch}`;
    if (!(await exists(local.worktree, tracking))) return 'push_and_open' as const;
    const ahead = await count(local.worktree, `${tracking}..HEAD`);
    const behind = await count(local.worktree, `HEAD..${tracking}`);
    if (behind > 0) return 'sync' as const;
    return ahead > 0 ? ('push_and_open' as const) : ('open' as const);
  }

  private async list(local: Local, state: 'all' | 'open'): Promise<RawPr[] | Failure> {
    const listed = await this.deps.gh([
      'pr',
      'list',
      '--repo',
      local.repo,
      '--head',
      local.branch,
      '--state',
      state,
      '--limit',
      '20',
      '--json',
      FIELDS,
    ]);
    if (listed.code !== 0) return failure(listed);
    try {
      const value = JSON.parse(listed.stdout) as unknown;
      return Array.isArray(value) ? (value as RawPr[]) : { kind: 'read_failed' };
    } catch {
      return { kind: 'read_failed' };
    }
  }

  private async local(sessionId: string): Promise<Local | Extract<PullRequestView, object>> {
    const copy = this.deps.copyOf(sessionId);
    if (!copy) return { kind: 'hidden', reason: 'no_paddock' };
    const url = await gitText(copy.root, ['config', '--get', 'remote.origin.url']).catch(() => '');
    const github = parseGitHubRemote(url);
    if (!github) return { kind: 'hidden', reason: 'not_github' };
    const repo = `${github.owner}/${github.name}`;
    const branch = await gitText(copy.worktree, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(
      () => '',
    );
    if (!branch) return { kind: 'hidden', reason: 'detached' };
    const head = await gitText(copy.worktree, ['rev-parse', 'HEAD']);
    const base = await this.defaultBranch(copy.root, repo);
    if (typeof base !== 'string') return base;
    if (base === branch) return { kind: 'hidden', reason: 'default_branch' };
    const baseRef = (await exists(copy.worktree, `refs/remotes/origin/${base}`))
      ? `refs/remotes/origin/${base}`
      : (await exists(copy.worktree, `refs/heads/${base}`))
        ? `refs/heads/${base}`
        : null;
    return { worktree: copy.worktree, root: copy.root, repo, branch, head, base, baseRef };
  }

  private async defaultBranch(root: string, repo: string): Promise<string | Failure> {
    const known = this.defaults.get(root);
    if (known) return known;
    const local = await gitText(root, [
      'symbolic-ref',
      '--short',
      '-q',
      'refs/remotes/origin/HEAD',
    ]).catch(() => '');
    let name = local.startsWith('origin/') ? local.slice('origin/'.length) : '';
    if (!name) {
      const viewed = await this.deps.gh(['repo', 'view', repo, '--json', 'defaultBranchRef']);
      if (viewed.code !== 0) return failure(viewed);
      try {
        name =
          (JSON.parse(viewed.stdout) as { defaultBranchRef?: { name?: string } }).defaultBranchRef
            ?.name ?? '';
      } catch {
        return { kind: 'read_failed' };
      }
      if (!name) return { kind: 'read_failed' };
    }
    this.defaults.set(root, name);
    return name;
  }
}

function refused(reason: Failure): OpenResult {
  return {
    ok: false,
    code: 'CAPABILITY_DENIED',
    message:
      reason.kind === 'gh_missing'
        ? 'install the GitHub CLI (gh)'
        : reason.kind === 'gh_signed_out'
          ? 'run gh auth login'
          : 'GitHub could not be read',
  };
}
