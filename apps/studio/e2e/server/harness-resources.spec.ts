import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './harness.ts';

test('[TC-HAR-004-H] install, trust, save and preview a mandatory skill through Settings', async ({
  page,
  corral,
}) => {
  const source = mkdtempSync(join(tmpdir(), 'corral-skill-ui-'));
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
    await corral.open('/settings/harness');
    await expect(page.getByRole('heading', { name: 'Work styles', exact: true })).toBeVisible();
    await page.getByLabel('Resource source').fill(source);
    await page.getByRole('button', { name: 'Review source', exact: true }).click();
    await expect(page.getByText('writing-pack · 1.0.0', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Install reviewed copy', exact: true }).click();
    const resource = page.getByTestId('resource-writing-pack');
    await expect(resource).toContainText('Not trusted');
    await resource.getByRole('button', { name: 'Trust this content', exact: true }).click();
    await page.getByLabel('Work style name', { exact: true }).fill('Evidence writer');
    await page.getByLabel('Use skill writing', { exact: true }).check();
    await page.getByLabel('Skill mode writing', { exact: true }).selectOption('mandatory');
    await page.getByRole('button', { name: 'Save work style', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Saved revision 1');
    await page.getByRole('button', { name: 'Preview effective settings', exact: true }).click();
    await expect(page.getByTestId('harness-preview')).toContainText('Always cite the source.');
    await page.reload();
    await page
      .getByLabel('Saved work style', { exact: true })
      .selectOption({ label: 'Evidence writer · r1' });
    await expect(page.getByLabel('Use skill writing', { exact: true })).toBeChecked();
    expect(corral.errors).toEqual([]);
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});
