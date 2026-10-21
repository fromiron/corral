import { fauxAssistantMessage, fauxToolCall } from '@corral/server/testing';
import { requestBox } from '../workbench.ts';
import { expect, test } from './harness.ts';

test('[TC-UX-006-H] [TC-UX-006-N] direct settings overlay preserves work, history and nested focus', async ({
  page,
  corral,
}) => {
  await corral.open('/projects/default');
  await page.goto(`${corral.server.url}/projects/default?settings=general#kept`);
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('app-sidebar')).toHaveCount(1);
  await dialog.getByRole('combobox', { name: 'Language', exact: true }).click();
  await expect(page.getByRole('option', { name: 'English', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Language', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: 'Close settings' }).click();
  await expect(page).toHaveURL(/\/projects\/default#kept$/);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close settings' }).click();
  await page.goForward();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('link', { name: 'Shortcuts', exact: true }).click();
  await page.goBack();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/projects\/default#kept$/);
  await page.goForward();
  await expect(dialog).toBeVisible();
  await page.reload();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close settings' }).click();
  await expect(page).toHaveURL(/\/projects\/default#kept$/);
});

test('[TC-UX-006-N] closing a pending save keeps its target and does not overwrite another project', async ({
  page,
  corral,
}) => {
  await corral.open('/projects/default');
  const otherProject = await page.evaluate(async () => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    const headers = { 'content-type': 'application/json', 'x-corral-csrf': csrfToken };
    const profile = await fetch('/api/v1/harness/profiles/modal-test', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        expectedRevision: 0,
        profile: {
          name: 'Modal style',
          policy: 'strict',
          resources: [],
          allowedTools: ['submit_result'],
          startupCommands: [],
        },
      }),
    });
    if (!profile.ok) throw new Error('profile fixture failed');
    const project = await fetch('/api/v1/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Other modal project' }),
    });
    return (await project.json()).project.projectId as string;
  });
  // Refresh the project list before opening a settings target.
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('link', { name: 'Default work style', exact: true }).click();
  await dialog.getByRole('combobox', { name: 'Project default', exact: true }).click();
  await page.getByRole('option', { name: 'Modal style · r1', exact: true }).click();
  // Browser Back is the same guarded transition as the close control.
  await page.evaluate(() => history.back());
  const guard = page.getByRole('dialog', { name: 'Unsaved settings' });
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: 'Keep editing' }).click();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  await page.route('**/harness/defaults/project/default', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    started = true;
    await waiting;
    await route.continue();
  });
  try {
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => started).toBe(true);
    await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('settings-operations')).toContainText('pending');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await dialog.getByRole('link', { name: 'Default work style', exact: true }).click();
    await dialog.getByRole('combobox', { name: 'Applies to project', exact: true }).click();
    await page.getByRole('option', { name: 'Other modal project', exact: true }).click();
    const choose = dialog.getByRole('combobox', { name: 'Project default', exact: true });
    await expect(choose).toContainText('None');
    release();
    await expect
      .poll(async () =>
        page.evaluate(
          async () =>
            (await (await fetch('/api/v1/harness/defaults/project/default')).json()).binding
              ?.profileId,
        ),
      )
      .toBe('modal-test');
    await expect(choose).toContainText('None');
    expect(
      await page.evaluate(
        async (id) =>
          (await (await fetch(`/api/v1/harness/defaults/project/${id}`)).json()).binding,
        otherProject,
      ),
    ).toBeNull();
  } finally {
    release();
  }
});

test.describe('active work and credentials', () => {
  test.use({ live: true, codexLogin: true });
  test('[TC-UX-006-N] streaming keeps one subscription and approval cannot steal settings focus', async ({
    page,
    corral,
  }) => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    corral.fake?.setResponses([
      fauxAssistantMessage('{"template":"single","reason":"A short question"}'),
      async () => {
        await waiting;
        return fauxAssistantMessage(
          [
            fauxToolCall('ask_user', {
              key: 'modal',
              questions: [{ id: 'answer', kind: 'text', prompt: 'Keep this question pending' }],
            }),
          ],
          { stopReason: 'toolUse' },
        );
      },
    ]);
    const subscriptions: string[] = [];
    const sessionReads: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (/\/runs\/[^/]+\/events$/.test(path)) subscriptions.push(path);
      if (request.method() === 'GET' && /\/api\/v1\/sessions\/[^/]+$/.test(path))
        sessionReads.push(path);
    });
    try {
      await corral.open('/projects/default');
      await page.getByRole('button', { name: 'Start chat', exact: true }).click();
      const input = requestBox(page);
      await input.fill('Ask before choosing');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.poll(() => corral.server.coordinator.listRuns().length).toBe(1);
      const run = corral.server.coordinator.listRuns()[0];
      if (!run) throw new Error('The request did not create a run');
      const runId = run.runId;
      await expect.poll(() => subscriptions.filter((path) => path.includes(runId)).length).toBe(1);
      await input.fill('다음 초안 日本語');
      await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(3, 3));
      const original = await input.elementHandle();
      const workUrl = page.url();
      const reads = sessionReads.length;
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
      await dialog.getByRole('link', { name: 'Models', exact: true }).click();
      const key = dialog.getByTestId('provider-openai').getByLabel('API key', { exact: true });
      await key.fill('fixture-secret');
      await key.dispatchEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true });
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Control+Alt+n');
      await page.keyboard.press('Control+.');
      await page.keyboard.press('Control+k');
      release();
      await expect(page.getByTestId('action-required')).toContainText('A question is waiting');
      await expect(key).toBeFocused();
      await expect(key).toHaveValue('fixture-secret');
      expect(await original?.evaluate((node) => node.isConnected)).toBe(true);
      expect(sessionReads.length).toBe(reads);
      expect(subscriptions.filter((path) => path.includes(runId))).toHaveLength(1);
      expect(corral.server.coordinator.listRuns()).toHaveLength(1);
      await dialog.getByRole('button', { name: 'Close settings' }).click();
      await page
        .getByRole('dialog', { name: 'Unsaved settings' })
        .getByRole('button', { name: 'Discard changes' })
        .click();
      await expect(page).toHaveURL(workUrl);
      await expect(input).toHaveValue('다음 초안 日本語');
      await expect(page.getByTestId('action-required')).toBeVisible();
      expect(await original?.evaluate((node: HTMLTextAreaElement) => node.selectionStart)).toBe(3);
      expect(
        await page.evaluate(() =>
          JSON.stringify({ history: history.state, storage: { ...localStorage } }),
        ),
      ).not.toContain('fixture-secret');
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await dialog.getByRole('link', { name: 'Models', exact: true }).click();
      await expect(
        dialog.getByTestId('provider-openai').getByLabel('API key', { exact: true }),
      ).toHaveValue('');
    } finally {
      release();
    }
  });
});

test.describe('settings layout and keyboard', () => {
  test.use({ live: true, codexLogin: true });
  test('[TC-UX-006-H] keyboard, light/dark, narrow reflow and explicit empty project scope', async ({
    page,
    corral,
  }) => {
    await corral.open('/projects/default');
    const trigger = page.getByRole('button', { name: 'Settings', exact: true });
    // Reach the entry by keyboard and keep its exact DOM node for focus restoration.
    for (
      let step = 0;
      step < 80 && !(await trigger.evaluate((node) => node === document.activeElement));
      step++
    )
      await page.keyboard.press('Tab');
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await expect(dialog).toBeVisible();
    for (let step = 0; step < 20; step++) {
      await page.keyboard.press('Tab');
      await expect
        .poll(() =>
          dialog.evaluate((node) =>
            node.contains(document.activeElement)
              ? 'inside'
              : (document.activeElement?.getAttribute('data-slot') ??
                document.activeElement?.tagName),
          ),
        )
        .toBe('inside');
    }
    await dialog.getByRole('radio', { name: 'Light', exact: true }).check();
    await dialog.getByRole('link', { name: 'Models', exact: true }).click();
    await expect(dialog.getByTestId('provider-openai')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('settings-wide-light.png') });
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    expect(
      (await new AxeBuilder({ page }).analyze()).violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => v.id),
    ).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press('Control+,');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Language', exact: true }).click();
    await page.getByRole('option', { name: '한국어', exact: true }).click();
    const korean = page.getByRole('dialog', { name: '설정', exact: true });
    await expect(korean).toBeVisible();
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await korean.getByRole('radio', { name: '다크', exact: true }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({ path: test.info().outputPath('settings-narrow-korean-dark.png') });
    expect(await korean.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await expect(korean.getByRole('button', { name: '설정 닫기', exact: true })).toBeInViewport();
    for (let step = 0; step < 15; step++) {
      await page.keyboard.press('Tab');
      await expect
        .poll(() =>
          korean.evaluate((node) =>
            node.contains(document.activeElement)
              ? 'inside'
              : (document.activeElement?.getAttribute('data-slot') ??
                document.activeElement?.tagName),
          ),
        )
        .toBe('inside');
    }
    await page.keyboard.press('Escape');
    await page.goto(`${corral.server.url}/projects?settings=workspace`);
    const empty = page.getByRole('dialog');
    await expect(empty.locator('.settings-content button')).toHaveCount(0);
    await expect(empty.getByRole('combobox').last()).toContainText('프로젝트');
    expect(corral.errors).toEqual([]);
  });
});

test('[TC-UX-006-N] a late profile save cannot erase another profile lost-response receipt', async ({
  page,
  corral,
}) => {
  await corral.open('/projects/default');
  await page.evaluate(async () => {
    const { csrfToken } = await (await fetch('/api/v1/session')).json();
    for (const id of ['a', 'b']) {
      const response = await fetch(`/api/v1/harness/profiles/modal-${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-corral-csrf': csrfToken },
        body: JSON.stringify({
          expectedRevision: 0,
          profile: {
            name: `Style ${id}`,
            policy: 'strict',
            resources: [],
            allowedTools: ['submit_result'],
            startupCommands: [],
          },
        }),
      });
      if (!response.ok) throw new Error('fixture profile failed');
    }
  });
  let finishA!: () => void, finishB!: () => void;
  const pendingA = new Promise<void>((resolve) => {
    finishA = resolve;
  });
  const pendingB = new Promise<void>((resolve) => {
    finishB = resolve;
  });
  let aStarted = false,
    bApplied = false;
  const bCommands: string[] = [];
  await page.route('**/harness/publish', async (route) => {
    const body = route.request().postDataJSON();
    if (body.profileId === 'modal-a') {
      aStarted = true;
      await pendingA;
      return route.continue();
    }
    bCommands.push(body.operationId);
    if (bCommands.length !== 1) return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    bApplied = true;
    await pendingB;
    await route.abort('failed');
  });
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  const open = async (id: string) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await dialog.getByRole('link', { name: 'Work styles', exact: true }).click();
    await dialog.getByRole('button', { name: `Style ${id} · r1`, exact: true }).click();
    await dialog.getByLabel('Work style name', { exact: true }).fill(`Updated ${id}`);
    await dialog.getByRole('button', { name: 'Save work style', exact: true }).click();
  };
  try {
    await open('a');
    await expect.poll(() => aStarted).toBe(true);
    await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await open('b');
    await expect.poll(() => bApplied).toBe(true);
    finishA();
    await expect(page.getByTestId('settings-operations')).toContainText('completed');
    finishB();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await dialog.getByRole('button', { name: 'Save work style', exact: true }).click();
    await expect(dialog.getByTestId('harness-status')).toContainText('Saved revision 2');
    expect(bCommands).toHaveLength(2);
    expect(bCommands[1]).toBe(bCommands[0]);
  } finally {
    finishA();
    finishB();
  }
});
