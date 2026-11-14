import { expect, type Locator, type Page, test } from '@playwright/test';
import en from '../../../packages/react/src/messages/en.json' with { type: 'json' };
import {
  newConversation,
  openProject,
  openSettings,
  panelTab,
  projectTab,
  teamFromTemplate,
} from './workbench.ts';

// The Paddock explains itself where it stands as a title (docs/specs/glossary.md, "설명이 붙는
// 용어"; features/term-hints.md): the Changes pane, the Changes page and the project's
// Environment tab, one icon each, on the title's line without making it taller.

const terms = en.Terms as unknown as Record<string, { name: string; meaning: string }>;
const paddock = terms.paddock as { name: string; meaning: string };
const about = en.Terms.about.replace('{term}', paddock.name);
const popup = (page: Page) => page.locator('[data-term-popup]');

/** The term of each info icon on the screen, counted. */
async function icons(page: Page) {
  const all = await page
    .locator('[data-term-hint]')
    .evaluateAll((found) => found.map((icon) => (icon as HTMLElement).dataset.termHint ?? ''));
  const counts: Record<string, number> = {};
  for (const term of all) counts[term] = (counts[term] ?? 0) + 1;
  return counts;
}

/**
 * The icon is named for its term, reads the meaning when pressed, stands right after the title
 * outside it, and the title's line is as tall with it as without it.
 */
async function explainsAfter(page: Page, title: Locator) {
  await expect(page.getByRole('button', { name: about, exact: true })).toHaveCount(1);
  // Located by its term, so it is found while taken out of the line too.
  const icon = page.locator('[data-term-hint="paddock"]');
  await expect(icon).toHaveAccessibleDescription(paddock.meaning);
  expect(await title.evaluate((node) => node.nextElementSibling?.matches('[data-term-hint]'))).toBe(
    true,
  );
  const line = title.locator('xpath=..');
  const height = async () => (await line.boundingBox())?.height;
  const withIcon = await height();
  await icon.evaluate((node) => {
    (node as HTMLElement).style.display = 'none';
  });
  const without = await height();
  await icon.evaluate((node) => {
    (node as HTMLElement).style.display = '';
  });
  expect(withIcon).toBe(without);
  await icon.click();
  await expect(popup(page).locator('[data-term-meaning]')).toHaveText(paddock.meaning);
  await page.keyboard.press('Escape');
  await expect(popup(page)).toHaveCount(0);
}

async function openConversation(page: Page) {
  await page.goto('/?delay=50');
  await teamFromTemplate(page);
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeEnabled();
  await newConversation(page);
}

test('the Changes pane explains the Paddock after its title, with and without one', async ({
  page,
}) => {
  await openConversation(page);
  await panelTab(page, 'Changes');
  const empty = page.getByText(en.Files.noCopyTitle, { exact: true });
  await expect(empty).toBeVisible();
  await explainsAfter(page, empty);
  expect(await icons(page)).toEqual({ paddock: 1 });

  // A trusted example folder, then a Paddock made from the pane.
  const dialog = await openSettings(page, 'Folders & tools');
  await dialog.getByRole('button', { name: en.Files.linkExample, exact: true }).click();
  await dialog.getByRole('switch', { name: en.Files.trust, exact: true }).click();
  await dialog.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.getByRole('button', { name: /^Make a Paddock from / }).click();
  await panelTab(page, 'Git');
  const title = page.getByRole('heading', { level: 3, name: en.Files.copyHeading, exact: true });
  await expect(title).toBeVisible();
  await explainsAfter(page, title);
  expect(await icons(page)).toEqual({ paddock: 1 });
});

// The Changes page's address opens the conversation on its Changes pane (router.tsx), so the
// page's own empty title never stands beside the pane's: the screen explains the term once.
test('the Changes page explains the Paddock once, after its empty title', async ({ page }) => {
  await openConversation(page);
  const sessionId = /\/sessions\/(session_[^/?#]+)/.exec(page.url())?.[1];
  await page.goto(`/sessions/${sessionId}/review`);
  await expect(page).toHaveURL(/panel=changes/);
  const empty = page.getByText(en.Files.noCopyTitle, { exact: true });
  await expect(empty).toHaveCount(1);
  await expect(empty).toBeVisible();
  await explainsAfter(page, empty);
  expect(await icons(page)).toEqual({ paddock: 1 });
});

test('the Environment tab explains the Paddock after its list label', async ({ page }) => {
  await openConversation(page);
  await openProject(page);
  await projectTab(page, 'Environment');
  const label = page
    .getByRole('tabpanel')
    .getByRole('heading', { level: 2, name: new RegExp(`^${en.Workspace.environment.copies}`) });
  await expect(label).toBeVisible();
  await explainsAfter(page, label);
  expect(await icons(page)).toEqual({ paddock: 1 });
});
