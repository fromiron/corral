import { expect, test } from '@playwright/test';
import { newConversation, requestBox } from './workbench.ts';

test('the kit themes preserve project creation and explicit theme choice', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => {
    if (!localStorage.getItem('corral:workbench:v1'))
      localStorage.setItem('corral:workbench:v1', JSON.stringify({ version: 1, theme: 'light' }));
  });
  await page.goto('/projects');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(250, 250, 250)');
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Design kit');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Design kit', exact: true })).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem('corral:workbench:v1', JSON.stringify({ version: 1, theme: 'dark' }));
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(23, 23, 23)');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('[data-slot="dialog-backdrop"]').first()).toHaveCSS(
    'background-color',
    /^(rgba\(0, 0, 0, 0\.8\)|oklab\(0 0 0 \/ 0\.8\))$/,
  );
});

test('the bundled Inter variable font renders the kit weights from the studio origin', async ({
  page,
}) => {
  const fontRequests: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fontRequests.push(request.url());
  });
  await page.goto('/projects');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toBeVisible();
  const faces = await page.evaluate(async () => {
    const loaded = await document.fonts.load('550 14px Inter');
    return loaded.map((face) => ({ family: face.family, status: face.status }));
  });
  expect(faces.length).toBeGreaterThan(0);
  expect(faces.every((face) => face.family.replaceAll('"', '') === 'Inter')).toBe(true);
  expect(faces.every((face) => face.status === 'loaded')).toBe(true);
  expect(await page.evaluate(() => document.fonts.check('550 14px Inter'))).toBe(true);
  const origin = new URL(page.url()).origin;
  expect(fontRequests.length).toBeGreaterThan(0);
  expect(fontRequests.every((url) => new URL(url).origin === origin)).toBe(true);
});

test('Hangul takes the kit weights from a bundled variable face after Inter', async ({ page }) => {
  const fontRequests: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fontRequests.push(request.url());
  });
  await page.goto('/projects');
  await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeVisible();
  const stack = await page.evaluate(() =>
    getComputedStyle(document.body)
      .fontFamily.split(',')
      .map((family) => family.trim().replaceAll('"', '')),
  );
  expect(stack.slice(0, 2)).toEqual(['Inter', 'Pretendard Variable']);
  const faces = await page.evaluate(() =>
    [...document.fonts]
      .filter((face) => face.family.replaceAll('"', '') === 'Pretendard Variable')
      .map((face) => ({ weight: face.weight, unicodeRange: face.unicodeRange })),
  );
  expect(faces).toHaveLength(1);
  const [face] = faces as [(typeof faces)[number]];
  const [lightest = Number.NaN, heaviest = lightest] = face.weight.split(' ').map(Number);
  expect(lightest).toBeLessThanOrEqual(400);
  expect(heaviest).toBeGreaterThanOrEqual(700);
  const ranges = face.unicodeRange.split(',').map((range) => {
    const [from = '', to = from] = range.trim().replace(/^U\+/i, '').split('-');
    return [Number.parseInt(from, 16), Number.parseInt(to, 16)] as const;
  });
  const covers = (from: number, to: number) =>
    ranges.some(([start, end]) => start <= from && to <= end);
  // Hangul syllables, Jamo and compatibility Jamo; Latin, digits and punctuation stay with Inter.
  expect(covers(0xac00, 0xd7a3)).toBe(true);
  expect(covers(0x1100, 0x11ff)).toBe(true);
  expect(covers(0x3131, 0x318e)).toBe(true);
  for (const character of 'Aa0,.·…') {
    const code = character.codePointAt(0) as number;
    expect(covers(code, code), character).toBe(false);
  }
  const hangul = await page.evaluate(async () => {
    const loaded = await document.fonts.load('550 14px "Pretendard Variable"', '판정');
    return loaded.map((loadedFace) => loadedFace.status);
  });
  expect(hangul).toEqual(['loaded']);
  const origin = new URL(page.url()).origin;
  expect(fontRequests.some((url) => /pretendard/i.test(url))).toBe(true);
  expect(fontRequests.every((url) => new URL(url).origin === origin)).toBe(true);
});

test('a row of box-drawing characters is as wide and as tall as a row of letters in the monospace family', async ({
  page,
}) => {
  await page.goto('/projects');
  await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeVisible();
  const rows = await page.evaluate(async () => {
    const bundled = [...document.fonts].filter((face) =>
      /JetBrains Mono|Geist Mono/.test(face.family),
    );
    await Promise.all(bundled.map((face) => face.load()));
    const measure = (text: string) => {
      const row = document.createElement('div');
      row.className = 'font-mono';
      row.style.cssText = 'position:absolute;white-space:pre;line-height:normal';
      row.textContent = text;
      document.body.append(row);
      const { width, height } = row.getBoundingClientRect();
      row.remove();
      return { width, height };
    };
    return {
      letters: measure('abcdefgh'),
      box: measure('\u2502\u2500\u253c\u2588\u251c\u2514\u2500\u2502'),
      mixed: measure('\u2502 ab \u2502 c'),
    };
  });
  expect(rows.letters.width).toBeGreaterThan(0);
  expect(rows.box).toEqual(rows.letters);
  expect(rows.mixed).toEqual(rows.letters);
});

test('code and paths take the bundled monospace face from the studio origin, with its ligatures off', async ({
  page,
}) => {
  const fontRequests: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fontRequests.push(request.url());
  });
  await page.goto('/projects');
  await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeVisible();
  const mono = await page.evaluate(async () => {
    const code = document.createElement('code');
    const classed = document.createElement('span');
    classed.className = 'font-mono';
    const typeset = document.createElement('div');
    typeset.className = 'typeset';
    const typesetCode = document.createElement('code');
    typeset.append(typesetCode);
    code.textContent = classed.textContent = typesetCode.textContent = 'a != b -> c';
    document.body.append(code, classed, typeset);
    const loaded = await document.fonts.load('14px "JetBrains Mono"', 'a != b -> c');
    const drawn = (element: Element) => {
      const style = getComputedStyle(element);
      return {
        family: style.fontFamily.split(',')[0]?.trim().replaceAll('"', ''),
        features: style.fontFeatureSettings,
      };
    };
    const result = {
      faces: loaded.map((face) => ({ family: face.family, status: face.status })),
      drawn: [drawn(code), drawn(classed), drawn(typesetCode)],
      token: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
    };
    code.remove();
    classed.remove();
    typeset.remove();
    return result;
  });
  expect(mono.faces.length).toBeGreaterThan(0);
  expect(mono.faces.every((face) => face.family.replaceAll('"', '') === 'JetBrains Mono')).toBe(
    true,
  );
  expect(mono.faces.every((face) => face.status === 'loaded')).toBe(true);
  for (const { family, features } of mono.drawn) {
    expect(family).toBe('JetBrains Mono');
    expect(features).toContain('"liga" 0');
    expect(features).toContain('"calt" 0');
  }
  expect(mono.token.startsWith('"JetBrains Mono"')).toBe(true);
  const origin = new URL(page.url()).origin;
  expect(fontRequests.some((url) => /jetbrains-mono/i.test(url))).toBe(true);
  expect(fontRequests.every((url) => new URL(url).origin === origin)).toBe(true);
});

test('narrow forms retain names, keyboard focus and reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
  await page.goto('/projects');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await expect(name).toBeVisible();
  await name.focus();
  await page.keyboard.type('Keyboard project');
  const create = page.getByRole('button', { name: 'Create project', exact: true });
  for (let step = 0; step < 8; step++) {
    await page.keyboard.press('Tab');
    if (await create.evaluate((element) => element === document.activeElement)) break;
  }
  await expect(create).toBeFocused();
  const focus = await create.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      visible: style.outlineStyle !== 'none' || style.boxShadow !== 'none',
      duration: Math.max(...style.transitionDuration.split(',').map(Number.parseFloat)),
    };
  });
  expect(focus.visible).toBe(true);
  expect(focus.duration).toBeLessThanOrEqual(0.00001);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Keyboard project', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('described select choices stay separated and readable without losing a draft', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await newConversation(page);
  await requestBox(page).fill('Keep this draft');
  const picker = page.getByRole('combobox', { name: 'Permissions for next request', exact: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await picker.click();
    const options = page.getByRole('option');
    await expect(options).toHaveCount(4);
    await expect
      .poll(() =>
        options.evaluateAll((rows) =>
          rows.every((row, index) => {
            const box = row.getBoundingClientRect();
            const previous = rows[index - 1]?.getBoundingClientRect();
            return (
              (!previous || box.top > previous.bottom + 1) &&
              box.left >= 0 &&
              box.right <= window.innerWidth &&
              Array.from(row.querySelectorAll('span')).every((span) => {
                if (!span.textContent?.trim()) return true;
                const content = span.getBoundingClientRect();
                return content.top >= box.top - 1 && content.bottom <= box.bottom + 1;
              })
            );
          }),
        ),
      )
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`described-select-${width}.png`) });
    await page.keyboard.press('Escape');
    await expect(picker).toBeFocused();
  }
  await picker.press('Enter');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(picker).toHaveText('Ask');
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  await expect(requestBox(page)).toHaveValue('Keep this draft');
});
