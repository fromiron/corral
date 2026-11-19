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

  test(`first save resolves and announces a duplicate template name in ${locale}`, async ({
    page,
    corral,
  }) => {
    await page.addInitScript((value) => localStorage.setItem('corral:locale', value), locale);
    await corral.open('/');
    const name = locale === 'en' ? 'Research team' : '조사 팀';
    const definition = { ...linearCorral(['writer']), name };
    await call(page, '/corrals', {
      definition,
    });
    await page.reload();
    // Templates are a view of the sidebar's Library.
    await page
      .getByTestId('app-sidebar')
      .getByRole('link', { name: locale === 'en' ? 'Library' : '라이브러리', exact: true })
      .click();
    await page
      .getByRole('tablist', { name: locale === 'en' ? 'Library views' : '라이브러리 보기' })
      .getByRole('tab', { name: locale === 'en' ? 'Templates' : '템플릿', exact: true })
      .click();
    await page
      .getByRole('link', {
        name: locale === 'en' ? `Edit a copy of ${name}` : `${name} 사본 편집`,
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(/\/corrals\/new\/edit\?/);
    const roster = page.getByRole('list', {
      name: locale === 'en' ? 'Team composition' : '팀 구성',
      exact: true,
    });
    await roster.getByRole('button', { name: locale === 'en' ? /^Request\b/ : /^요청/ }).click();
    const input = page.getByRole('textbox', {
      name: locale === 'en' ? 'Name' : '이름',
      exact: true,
    });
    const announcement = page.getByRole('status').filter({ hasText: `${name} (2)` });
    await expect(input).toHaveValue(name);
    await expect(announcement).toHaveCount(0);
    await input.fill('Different name');
    await expect(input).toHaveValue('Different name');
    await input.fill(name);
    expect(await call(page, '/corrals', undefined, 'GET')).toHaveLength(1);
    await page
      .getByRole('button', { name: locale === 'en' ? 'Save' : '저장', exact: true })
      .click();
    await expect(page).toHaveURL(/\/corrals\/(?!new\/)[^/?#]+\/edit$/);
    await expect(announcement).toHaveCount(1);
    // The editor names the open team in its heading; the name field is in its settings.
    await expect(
      page.getByRole('heading', { level: 1, name: `${name} (2)`, exact: true }),
    ).toBeVisible();
    const teams = await call(page, '/corrals', undefined, 'GET');
    expect(teams).toHaveLength(2);
    expect(teams.map((team: { name: string }) => team.name)).toEqual(
      expect.arrayContaining([name, `${name} (2)`]),
    );
  });
}
