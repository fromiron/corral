import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { linearCorral } from '@corral/testkit';
import { expect, test } from './harness.ts';

test.use({ live: true, codexLogin: true });
test('[TC-HAR-018-H] reviews immutable LSP changes and applies them explicitly to the session copy', async ({
  page,
  corral,
}) => {
  const source = mkdtempSync(join(tmpdir(), 'corral-lsp-proposal-ui-'));
  try {
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
        { cwd: source },
      );
    git('init', '-q');
    const protocol = createRequire(
      new URL('../../../server/package.json', import.meta.url),
    ).resolve('vscode-languageserver-protocol/node');
    writeFileSync(
      join(source, 'lsp.mjs'),
      readFileSync(
        new URL('../../../server/test/fixtures/lsp-server.mjs', import.meta.url),
        'utf8',
      ).replace(
        "'vscode-languageserver-protocol/node'",
        JSON.stringify(pathToFileURL(protocol).href),
      ),
    );
    writeFileSync(join(source, 'main.ts'), 'value\n');
    git('add', '.');
    git('commit', '-qm', 'fixture');
    await corral.open('/settings/harness');
    corral.fake?.answerWith('Rename proposed.', {
      lspQuery: {
        serverId: 'typescript',
        operation: 'rename',
        path: 'main.ts',
        position: { line: 0, character: 0 },
        newName: 'renamed',
      },
    });
    const definition = linearCorral(['writer']);
    definition.roles[0]!.modelProfile = 'model-b';
    definition.roles[0]!.allowedWorkTools.push('read_file');
    definition.roles[0]!.harness = { profileId: 'lsp-writer', revision: 1 };
    const ids = await page.evaluate(
      async ({ source, definition }) => {
        const { csrfToken } = await (await fetch('/api/v1/session')).json();
        const call = async (path: string, body: unknown, method = 'POST') => {
          const response = await fetch(`/api/v1${path}`, {
            method,
            headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
            body: JSON.stringify(body),
          });
          if (!response.ok) throw new Error(`setup ${path}: ${response.status}`);
          return response.json();
        };
        await call('/projects/default/workspace', { path: source }, 'PUT');
        await call('/projects/default/workspace', { trusted: true }, 'PATCH');
        await call(
          '/harness/projects/default/tools',
          {
            expectedRevision: 0,
            config: {
              checks: [],
              lspServers: [
                {
                  id: 'typescript',
                  name: 'Fixture',
                  argv: ['node', 'lsp.mjs'],
                  timeoutMs: 5000,
                  languageIds: ['typescript'],
                  fileExtensions: ['.ts'],
                },
              ],
            },
          },
          'PUT',
        );
        await call(
          '/harness/profiles/lsp-writer',
          {
            expectedRevision: 0,
            profile: {
              name: 'LSP writer',
              policy: 'strict',
              resources: [],
              allowedTools: ['lsp_query', 'write_artifact', 'submit_result'],
              startupCommands: [],
              lspServerIds: ['typescript'],
            },
          },
          'PUT',
        );
        const session = await call('/sessions', { projectId: 'default', title: 'Rename review' });
        const sessionId = session.session.sessionId;
        await call(`/sessions/${sessionId}/worktree`, {});
        const saved = await call('/corrals', {
          definition,
          layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
        });
        const started = await call('/runs', {
          schemaVersion: '0.1',
          commandId: 'rename-run',
          corralId: saved.record.corralId,
          definitionRevision: 1,
          sessionId,
          mode: 'live',
        });
        return { sessionId, runId: started.runId };
      },
      { source, definition },
    );
    await page.goto(`${corral.server.url}/runs/${ids.runId}?view=run`);
    await page.getByRole('button', { name: 'Run this query once', exact: true }).click();
    await expect(page.getByTestId('run-status').first()).toContainText('Succeeded');
    const before = await page.evaluate(
      async (id) =>
        (await (await fetch(`/api/v1/sessions/${id}/worktree/file?path=main.ts`)).json()).content
          .text,
      ids.sessionId,
    );
    expect(before).toBe('value\n');
    await page.goto(`${corral.server.url}/sessions/${ids.sessionId}/review`);
    await page.getByRole('button', { name: 'Review Rename to renamed', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('main.ts');
    await expect(page.getByTestId('file-diff')).toBeVisible();
    await page.getByRole('button', { name: 'Apply 1 file change', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Applied');
    const after = await page.evaluate(
      async (id) =>
        (await (await fetch(`/api/v1/sessions/${id}/worktree/file?path=main.ts`)).json()).content
          .text,
      ids.sessionId,
    );
    expect(after).toBe('renamed\n');
    expect(readFileSync(join(source, 'main.ts'), 'utf8')).toBe('value\n');
    expect(corral.errors).toEqual([]);
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});
