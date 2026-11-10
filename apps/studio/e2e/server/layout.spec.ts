import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editModels, modelSettingsTab } from '../workbench.ts';
import { expect, test } from './harness.ts';

// Settings layout regressions from the workbench audit (#75 onwards) that need the server.

test.describe('model profiles', () => {
  // Profiles appear when the workspace has model configuration (as in models.spec.ts).
  test.use({ live: true });
  test('#75 model profile fields keep visible titles and a visible remove action', async ({
    page,
    corral,
  }) => {
    await corral.open('/settings/models');
    await editModels(page);
    const editor = page.getByRole('region', { name: 'Edit models' });
    await expect(editor.getByText('Profile name', { exact: true }).first()).toBeVisible();
    await expect(editor.getByText('Provider', { exact: true }).first()).toBeVisible();
    await expect(editor.getByText('Model', { exact: true }).first()).toBeVisible();
    const remove = editor.getByRole('button', { name: 'Remove model-a', exact: true });
    await expect(remove).toHaveText('Remove');
    // The accessible names stay on the controls.
    await expect(
      editor.getByRole('combobox', { name: 'Model of model-a', exact: true }),
    ).toBeVisible();
    expect(corral.errors).toEqual([]);
  });
});

test('#75 the archived resources filter is named by its visible text', async ({ page, corral }) => {
  // An empty library shows one empty state; the filter appears once a Skill exists.
  const source = mkdtempSync(join(tmpdir(), 'corral-archived-filter-'));
  try {
    mkdirSync(join(source, 'skills', 'writing'), { recursive: true });
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({
        name: 'writing-pack',
        version: '1.0.0',
        license: 'MIT',
        pi: { skills: ['./skills'] },
      }),
    );
    writeFileSync(
      join(source, 'skills', 'writing', 'SKILL.md'),
      '---\nname: writing\ndescription: Write with sources.\n---\nAlways cite the source.',
    );
    await corral.open('/settings/skills');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('combobox', { name: 'Add method', exact: true }).click();
    await page.getByRole('option', { name: 'Import folder', exact: true }).click();
    await page.getByLabel('Resource folder', { exact: true }).fill(source);
    await page.getByRole('button', { name: 'Review source', exact: true }).click();
    await page.getByRole('button', { name: 'Save to library', exact: true }).click();
    const filter = page.getByRole('switch', { name: 'Show archived items', exact: true });
    await expect(filter).toBeVisible();
    await page.getByText('Show archived items', { exact: true }).click();
    await expect(filter).toBeChecked();
    expect(corral.errors).toEqual([]);
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test('#79 without a default, adoption points to the chosen scope defaults screen', async ({
  page,
  corral,
}) => {
  await corral.open('/settings/skills');
  await page.evaluate(async () => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const call = async (path: string, body: unknown, method = 'POST') => {
      const response = await fetch(`/api/v1/harness${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`setup failed: ${path} ${response.status}`);
      return response.json();
    };
    const review = await call('/documents/review', {
      kind: 'skill',
      name: 'Writing',
      content: '---\nname: writing\ndescription: Layout fixture writer\n---\nAnswer briefly.',
    });
    const saved = await call('/resources', { reviewId: review.reviewId });
    await call(`/resources/${saved.hash}/trust`, { trusted: true }, 'PUT');
  });
  await page.reload();
  await page.getByRole('button', { name: /Layout fixture writer/ }).click();
  // One way to Work styles, named for what happens there.
  await expect(page.getByRole('link', { name: 'Connect in Work styles', exact: true })).toHaveCount(
    1,
  );
  await expect(page.getByRole('link', { name: 'Manage work styles', exact: true })).toHaveCount(0);
  const panel = page.getByTestId('skill-quality');
  await panel.getByText('Evaluate, adopt and roll back', { exact: true }).click();
  const defaults = panel.getByRole('link', { name: /default work style/ });
  await expect(defaults).toHaveAttribute('href', /settings\/defaults|settings=defaults/);
  await panel.getByRole('combobox', { name: 'Apply to', exact: true }).click();
  await page.getByRole('option').nth(1).click();
  await expect(defaults).toHaveAttribute('href', /project-defaults/);
  expect(corral.errors).toEqual([]);
});

test('#80 settings say which project they target, that work styles are shared, and three selection states', async ({
  page,
  corral,
}) => {
  await corral.open('/settings/harness');
  await expect(page.getByTestId('shared-scope')).toContainText('Shared work style');
  const checks = page.getByRole('combobox', {
    name: 'Select registered checks for this style',
    exact: true,
  });
  await expect(checks).toHaveText(/Follow the parent setting/);
  await checks.click();
  await page.getByRole('option', { name: 'Use none', exact: true }).click();
  await expect(checks).toHaveText(/Use none/);
  expect(corral.errors).toEqual([]);
});

test('#80 a project settings page shows its target project as a visible scope', async ({
  page,
  corral,
}) => {
  // From a work URL the target is the current project (a bare /settings URL opens over the
  // project list, where the project is chosen explicitly). The one project choice heads the
  // navigation's project group (workbench.md 문맥형 설정).
  await corral.open('/projects/default?settings=mcp');
  await expect(page.getByRole('combobox', { name: 'Settings for', exact: true })).toContainText(
    'My project',
  );
  expect(corral.errors).toEqual([]);
});

test('#81 typed evaluation requests survive switching Skills and leaving asks first', async ({
  page,
  corral,
}) => {
  await corral.open('/settings/skills');
  await page.evaluate(async () => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const call = async (path: string, body: unknown, method = 'POST') => {
      const response = await fetch(`/api/v1/harness${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`setup failed: ${path} ${response.status}`);
      return response.json();
    };
    for (const [name, description] of [
      ['first', 'First draft writer'],
      ['second', 'Second draft writer'],
    ]) {
      const review = await call('/documents/review', {
        kind: 'skill',
        name,
        content: `---\nname: ${name}\ndescription: ${description}\n---\nAnswer briefly.`,
      });
      const saved = await call('/resources', { reviewId: review.reviewId });
      await call(`/resources/${saved.hash}/trust`, { trusted: true }, 'PUT');
    }
  });
  await page.reload();
  await page.getByRole('button', { name: /First draft writer/ }).click();
  const panel = page.getByTestId('skill-quality');
  await panel.getByText('Evaluate, adopt and roll back', { exact: true }).click();
  const request = panel.getByRole('textbox', { name: 'Test request', exact: true }).first();
  await request.fill('Keep this unsent request');
  await page.getByRole('button', { name: /Second draft writer/ }).click();
  await page.getByRole('button', { name: /First draft writer/ }).click();
  await panel.getByText('Evaluate, adopt and roll back', { exact: true }).click();
  await expect(request).toHaveValue('Keep this unsent request');
  await expect(panel.getByText('Your unsent test requests were kept from before.')).toBeVisible();
  await page.getByRole('link', { name: 'Models', exact: true }).click();
  await expect(page.getByRole('alertdialog').or(page.getByRole('dialog'))).toBeVisible();
  expect(corral.errors).toEqual([]);
});

test.describe('long settings pages', () => {
  test.use({ live: true });
  test('#82 Models and Hooks list what they manage at the top', async ({ page, corral }) => {
    await corral.open('/settings/models');
    // Models lists what it manages as its tabs (each keeps a hidden copy of its label for width).
    const tabs = page
      .getByRole('tablist', { name: 'Model settings', exact: true })
      .getByRole('tab');
    const names = ['Sign-in', 'Profiles', 'Local AI & judgment', 'Images', 'Usage'];
    await expect(tabs).toHaveCount(names.length);
    for (const [index, name] of names.entries())
      await expect(tabs.nth(index)).toHaveAccessibleName(name);
    const images = await modelSettingsTab(page, 'Images');
    await expect(
      images.getByRole('region', { name: 'Image generation', exact: true }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Hooks & extensions', exact: true }).click();
    await expect(
      page
        .getByRole('navigation', { name: 'On this page', exact: true })
        .getByRole('button', { name: 'Packages', exact: true }),
    ).toBeVisible();
    expect(corral.errors).toEqual([]);
  });
});

test('#88 both default screens show the same four-step ladder and mark which step is edited', async ({
  page,
  corral,
}) => {
  await corral.open('/settings/defaults');
  for (const [path, here] of [
    ['/settings/defaults', 'Personal default'],
    ['/settings/project-defaults?projectId=default', 'Project default'],
  ] as const) {
    // Later pages reuse the session cookie.
    await page.goto(`${corral.server.url}${path}`);
    const ladder = page.getByRole('list', { name: 'Which work style a run uses', exact: true });
    await expect(ladder.getByRole('listitem')).toHaveCount(4);
    await expect(ladder.getByRole('listitem').locator('h4')).toHaveText([
      'Personal default',
      'Project default',
      'Team role',
      'This run',
    ]);
    await expect(ladder.locator('[aria-current="step"] h4')).toHaveText(here);
  }
  // The other default is one link away instead of in another settings group.
  await page
    .getByRole('list', { name: 'Which work style a run uses', exact: true })
    .getByRole('link', { name: 'Personal default', exact: true })
    .click();
  await expect(
    page
      .locator('[data-settings-header]')
      .getByRole('heading', { name: 'Personal default work style', exact: true }),
  ).toBeVisible();
  expect(corral.errors).toEqual([]);
});

test('#88 a settings address opens the same settings dialog over work, and closing it leaves no settings page', async ({
  page,
  corral,
}) => {
  await corral.open('/settings/skills');
  // Entering by address shows the dialog form, not a separate page with its own back rules.
  await expect(page).toHaveURL(/\/projects\?(?:.*&)?settings=skills/);
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog.getByRole('button', { name: 'Add', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).not.toHaveURL(/settings/);
  // A project section keeps its project.
  await page.goto(`${corral.server.url}/settings/project-defaults?projectId=default`);
  await expect(page).toHaveURL(/\/projects\?(?:.*&)?settings=project-defaults/);
  await expect(page).toHaveURL(/settingsProject=default/);
  await expect(
    page
      .getByRole('dialog', { name: 'Settings', exact: true })
      .getByRole('list', { name: 'Which work style a run uses', exact: true }),
  ).toBeVisible();
  expect(corral.errors).toEqual([]);
});
