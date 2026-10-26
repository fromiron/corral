import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessApi, RestCorralRepository, WorkspacesApi } from '@corral/client';
import type { GitWriteCommand } from '@corral/contracts';
import { ScriptedAgentAdapter } from '@corral/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { startCorralServer } from '../src/index.ts';

type GitAction<Command = GitWriteCommand> = Command extends GitWriteCommand
  ? Omit<Command, 'target' | 'expect'>
  : never;

vi.setConfig({ testTimeout: 40_000 });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

it.skipIf(process.platform !== 'linux')(
  'preserves checked source through multi-file edits, commit, local push and explicit deployment readback',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'corral-workbench-journey-'));
    cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args],
        { cwd, encoding: 'utf8' },
      ).trim();
    const original = join(root, 'original');
    const remote = join(root, 'remote.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    git(root, 'init', '-q', '-b', 'main', original);
    git(original, 'config', 'user.name', 'Fixture');
    git(original, 'config', 'user.email', 'fixture@example.test');
    writeFileSync(join(original, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(original, '.gitignore'), 'deployment-result.json\ndeploy-count\n');
    writeFileSync(join(original, 'value.ts'), "export const oldName: string = 'ready';\n");
    writeFileSync(
      join(original, 'main.ts'),
      "import { oldName } from './value.ts';\nexport const result = oldName;\n",
    );
    writeFileSync(
      join(original, 'check.mjs'),
      "import assert from 'node:assert/strict';\nimport { newName } from './value.ts';\nimport { result } from './main.ts';\nassert.equal(newName, 'ready');\nassert.equal(result, newName);\nconsole.log('source checks passed');\n",
    );
    writeFileSync(
      join(original, 'deploy.cjs'),
      `const fs = require('node:fs');
fs.appendFileSync('deploy-count', 'x');
fs.writeFileSync('deployment-result.json', JSON.stringify({
  operationId: process.env.CORRAL_DEPLOYMENT_OPERATION,
  environment: process.env.CORRAL_DEPLOYMENT_ENVIRONMENT,
  sourceCommit: process.env.CORRAL_DEPLOYMENT_COMMIT || null,
  sourceTree: process.env.CORRAL_DEPLOYMENT_TREE,
  deploymentId: 'journey-fixture', status: 'succeeded', url: null
}));\n`,
    );
    writeFileSync(
      join(original, 'readback.cjs'),
      "process.stdout.write(require('node:fs').readFileSync('deployment-result.json'));\n",
    );
    git(original, 'add', '.');
    git(original, 'commit', '-qm', 'Fixture');
    git(original, 'remote', 'add', 'origin', remote);
    git(original, 'push', '-q', 'origin', 'main');
    const originalHead = git(original, 'rev-parse', 'HEAD');

    const token = 'workbench-journey-fixture-0123456789ab';
    const server = await startCorralServer({
      workspace: join(root, 'workspace'),
      worktreeRoot: join(root, 'copies'),
      bootstrapToken: token,
      agents: new ScriptedAgentAdapter({ turns: 1 }),
      port: 0,
    });
    cleanups.push(() => server.close());
    const login = await fetch(`${server.url}/api/v1/session`, {
      method: 'POST',
      headers: { origin: server.url, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(login.status).toBe(204);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const call: typeof fetch = (url, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('origin', server.url);
      headers.set('cookie', cookie);
      headers.set('x-corral-csrf', login.headers.get('x-corral-csrf') ?? '');
      return fetch(url, { ...init, headers });
    };
    const options = { baseUrl: server.url, fetch: call };
    const repository = new RestCorralRepository(options);
    const workspaces = new WorkspacesApi(options);
    const binding = await workspaces.bind('default', original);
    await workspaces.configure('default', { trusted: true });
    await new HarnessApi(options).saveProjectTools('default', 0, {
      checks: [
        {
          id: 'check',
          name: 'Source checks',
          argv: [process.execPath, 'check.mjs'],
          timeoutMs: 5000,
        },
      ],
      lspServers: [],
      deployments: [
        {
          id: 'local',
          name: 'Local fixture',
          environment: 'preview',
          argv: [process.execPath, 'deploy.cjs'],
          readbackArgv: [process.execPath, 'readback.cjs'],
          timeoutMs: 5000,
          envRefs: [],
        },
      ],
    });
    const created = await repository.createSession({ projectId: 'default', title: 'Journey' });
    assert(created.ok);
    const sessionId = created.session.sessionId;
    await workspaces.createWorktree(sessionId);
    const copy = join(root, 'copies', binding.bindingId, sessionId);
    const { target } = await workspaces.readDocument(sessionId, 'value.ts');
    const scope = { kind: 'session' as const, id: sessionId };
    const gitChange = async (command: GitAction) => {
      const status = await workspaces.gitStatus(scope);
      return workspaces.gitChange(sessionId, {
        ...command,
        target,
        expect: { head: status.head.oid, indexHash: status.indexHash },
      });
    };
    const verify = async () => {
      const { verificationId } = await workspaces.verify(sessionId, 'check');
      return vi.waitFor(async () => {
        const report = (await workspaces.verifications(sessionId)).find(
          (entry) => entry.verificationId === verificationId,
        );
        assert(report);
        expect(report.state).not.toBe('running');
        return report;
      });
    };

    const failed = await verify();
    expect(failed).toMatchObject({ state: 'failed', stale: false });
    expect(failed.output).toContain('newName');
    const beforeEdits = await workspaces.inspectDeployment(sessionId, {
      target,
      profileId: 'local',
    });
    const search = await workspaces.searchContents(sessionId, {
      target,
      queryId: 'journey_search',
      query: 'oldName',
      caseSensitive: false,
    });
    expect([...new Set(search.matches.map((match) => match.path))].sort()).toEqual([
      'main.ts',
      'value.ts',
    ]);
    const { proposals } = await workspaces.previewFileEdits(sessionId, {
      kind: 'replace',
      target,
      requestId: 'journey_replace',
      query: 'oldName',
      caseSensitive: false,
      replacement: 'newName',
    });
    const proposal = proposals[0];
    assert(proposal);
    expect(proposal.files).toHaveLength(2);
    expect(
      await workspaces.applyFileEdits(sessionId, proposal.proposalId, {
        operationId: 'journey_apply',
        target,
        proposalHash: proposal.hash,
      }),
    ).toMatchObject({ state: 'succeeded' });
    await expect(
      workspaces.startDeployment(sessionId, {
        operationId: 'journey_stale_deploy',
        target,
        profileId: 'local',
        fingerprint: beforeEdits.fingerprint,
        allowDirty: true,
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(existsSync(join(copy, 'deploy-count'))).toBe(false);
    expect((await workspaces.deployments(sessionId)).deployments).toEqual([]);
    const checked = await verify();
    expect(checked).toMatchObject({ state: 'passed', stale: false, exitCode: 0 });
    expect(
      (await workspaces.verifications(sessionId)).find(
        (entry) => entry.verificationId === failed.verificationId,
      ),
    ).toMatchObject({ stale: true });

    expect(
      await gitChange({ kind: 'branch', operationId: 'journey_branch', name: 'journey' }),
    ).toMatchObject({ state: 'succeeded' });
    expect(
      await gitChange({
        kind: 'stage',
        operationId: 'journey_stage',
        paths: ['main.ts', 'value.ts'],
      }),
    ).toMatchObject({ state: 'succeeded' });
    expect(
      await gitChange({
        kind: 'commit',
        operationId: 'journey_commit',
        message: 'Rename greeting',
        staged: ['main.ts', 'value.ts'],
        runHooks: false,
      }),
    ).toMatchObject({ state: 'succeeded' });
    expect(
      await gitChange({
        kind: 'push',
        operationId: 'journey_push',
        remote: 'origin',
        branch: 'journey',
        runHooks: false,
      }),
    ).toMatchObject({ state: 'succeeded' });
    const head = git(copy, 'rev-parse', 'HEAD');
    expect(git(remote, 'rev-parse', 'refs/heads/journey')).toBe(head);
    expect(git(copy, 'rev-parse', 'HEAD^{tree}')).toBe(checked.tree);
    const plan = await workspaces.inspectDeployment(sessionId, { target, profileId: 'local' });
    expect(plan.source).toEqual({ commit: head, tree: checked.tree, dirty: false });
    const deployment = {
      operationId: 'journey_deploy',
      target,
      profileId: 'local',
      fingerprint: plan.fingerprint,
      allowDirty: false,
    };
    await workspaces.startDeployment(sessionId, deployment);
    await vi.waitFor(async () =>
      expect(await workspaces.deployment(sessionId, deployment.operationId)).toMatchObject({
        state: 'uncertain',
        exitCode: 0,
        cleanupConfirmed: true,
        readback: null,
      }),
    );
    expect(
      await workspaces.checkDeployment(sessionId, deployment.operationId, { target }),
    ).toMatchObject({
      state: 'succeeded',
      readback: { sourceCommit: head, sourceTree: checked.tree, deploymentId: 'journey-fixture' },
    });
    expect(await workspaces.startDeployment(sessionId, deployment)).toMatchObject({
      state: 'succeeded',
    });
    expect(readFileSync(join(copy, 'deploy-count'), 'utf8')).toBe('x');
    expect(git(original, 'rev-parse', 'HEAD')).toBe(originalHead);
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(originalHead);
    expect(git(original, 'status', '--porcelain')).toBe('');
    expect(git(copy, 'status', '--porcelain')).toBe('');
  },
);
