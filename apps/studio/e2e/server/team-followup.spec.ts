import { linearCorral } from '@corral/testkit';
import type { Page } from '@playwright/test';
import { expect, test } from './harness.ts';

async function call(page: Page, path: string, body?: unknown, method = 'POST') {
  return page.evaluate(
    async ({ path, body, method }) => {
      const { csrfToken } = await (await fetch('/api/v1/session')).json();
      const response = await fetch(`/api/v1${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(`${path}: ${response.status}`);
      return response.json();
    },
    { path, body, method },
  );
}

for (const locale of ['en', 'ko'] as const) {
  test(`referenced work style shows the project name and collapsed diagnostics in ${locale}`, async ({
    page,
    corral,
  }) => {
    await page.addInitScript((value) => localStorage.setItem('corral:locale', value), locale);
    await corral.open('/');
    const project = (await call(page, '/projects', { name: 'Evidence project' })).project;
    const profile = {
      name: 'Evidence style',
      policy: 'strict',
      allowedTools: [],
      resources: [],
      startupCommands: [],
    };
    await call(page, '/harness/profiles/evidence', { expectedRevision: 0, profile }, 'PUT');
    await call(
      page,
      `/harness/defaults/project/${project.projectId}`,
      { expectedRevision: 0, binding: { profileId: 'evidence', revision: 1 } },
      'PUT',
    );
    await call(
      page,
      '/harness/profiles/evidence',
      { expectedRevision: 1, profile: { ...profile, name: 'Evidence style 2' } },
      'PUT',
    );
    await page.goto(
      `${corral.server.url}/projects/${project.projectId}?settings=harness&settingsProject=${project.projectId}`,
    );
    await page.getByRole('button', { name: 'Evidence style 2 · r2', exact: true }).click();
    const usages = page.getByRole('region', {
      name: locale === 'en' ? 'Versions referenced by settings' : '설정에서 사용 중인 버전',
    });
    await expect(usages).toContainText('Evidence project · r1');
    const details = usages.locator('details');
    await expect(details).not.toHaveAttribute('open', '');
    const diagnostic = details.locator('code');
    await expect(diagnostic).toBeHidden();
    await details.locator('summary').click();
    await expect(diagnostic).toHaveText(`project:${project.projectId}`);
    await diagnostic.selectText();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
      `project:${project.projectId}`,
    );
    expect(
      (await call(page, `/harness/defaults/project/${project.projectId}`, undefined, 'GET'))
        .binding,
    ).toEqual({ profileId: 'evidence', revision: 1 });
  });

  test(`template duplicate name is previewed before save in ${locale}`, async ({
    page,
    corral,
  }) => {
    await page.addInitScript((value) => localStorage.setItem('corral:locale', value), locale);
    await corral.open('/');
    const name = locale === 'en' ? 'Research team' : '조사 팀';
    const definition = { ...linearCorral(['writer']), name };
    await call(page, '/corrals', {
      definition,
      layout: { nodes: {}, viewport: { x: 0, y: 0, zoom: 1 } },
    });
    await page.reload();
    await page.getByRole('tab', { name: locale === 'en' ? /^Teams/ : /^팀/ }).click();
    await page
      .getByRole('button', {
        name: locale === 'en' ? 'Edit this team' : '팀 편집해서 쓰기',
        exact: true,
      })
      .first()
      .click();
    const dialog = page.getByRole('dialog', {
      name: locale === 'en' ? 'Save a team copy' : '팀 사본 저장',
    });
    const input = dialog.getByRole('textbox', {
      name: locale === 'en' ? 'Team name' : '팀 이름',
      exact: true,
    });
    await expect(input).toHaveValue(name);
    await expect(dialog.getByRole('status')).toContainText(`${name} (2)`);
    await input.fill('Different name');
    await expect(dialog.getByRole('status')).toHaveCount(0);
    await input.fill(name);
    await expect(dialog.getByRole('status')).toContainText(`${name} (2)`);
    await dialog
      .getByRole('button', {
        name: locale === 'en' ? 'Save copy and edit' : '사본 저장하고 편집',
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(/\/edit$/);
    await expect(
      page.getByRole('textbox', { name: locale === 'en' ? 'Team name' : '팀 이름', exact: true }),
    ).toHaveValue(`${name} (2)`);
    const teams = await call(page, '/corrals', undefined, 'GET');
    expect(teams.map((team: { name: string }) => team.name)).toEqual(
      expect.arrayContaining([name, `${name} (2)`]),
    );
  });
}
