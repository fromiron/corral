import { expect, test } from './harness.ts';

test.use({ live: true });
test.skip(
  `${process.platform}-${process.arch}` !== 'linux-x64',
  'Corral ships the Local engine for Linux x64 only',
);

test('Manual with the Local engine survives a server restart and downloads nothing', async ({
  page,
  corral,
}) => {
  const failed: string[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/api/v1/effort-routing') && !response.ok())
      failed.push(`${response.request().method()} ${response.status()}`);
  });
  await corral.open('/settings/models');
  const section = page.getByRole('region', { name: 'Reasoning judgment', exact: true });
  await expect(section.getByRole('radio', { name: 'Off', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await section.getByRole('radio', { name: 'Manual', exact: true }).click();
  await expect(section.getByRole('radio', { name: 'Local judge model' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await section.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(section.getByText('Saved', { exact: true })).toBeVisible();

  // Reopen after a closed-app restart; leave no old page polling the stopped server.
  await page.goto('about:blank');
  await corral.restart();
  await corral.open('/settings/models');
  await expect(section.getByRole('radio', { name: 'Manual', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(section.getByRole('radio', { name: 'Local judge model' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  const stored = await page.evaluate(async () => (await fetch('/api/v1/effort-routing')).json());
  expect(stored.settings).toMatchObject({ mode: 'manual', engine: { kind: 'local' } });
  // Saving chose the engine; only the Install button downloads it.
  expect(['downloading', 'verifying']).not.toContain(stored.local.install);
  await section.screenshot({ path: test.info().outputPath('effort-routing.png') });
  expect(failed).toEqual([]);
  expect(corral.errors).toEqual([]);
});
