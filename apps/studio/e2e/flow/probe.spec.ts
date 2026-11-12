import { expect, test } from '@playwright/test';
import { countVisibleLabels, createProbe } from './probe.ts';

// The probe on small synthetic pages: no server, no app code.

const page = `
<style>body { margin: 0 } #list { height: 300px; overflow-y: auto } li { height: 40px }</style>
<div id="list"><ol>
  <li data-chat-item="a"><span data-chat-part="p1">a</span></li>
  <li data-chat-item="b">b</li>
  <li data-chat-item="c">c</li>
</ol></div>
<div data-testid="chat-composer"><textarea></textarea></div>`;

test('the first edge sample is read in start(), so a change right after it counts', async ({
  page: tab,
}) => {
  await tab.setContent(page);
  const probe = createProbe(tab);
  await probe.start('immediate');
  await tab.evaluate(() => {
    document.querySelector('textarea')?.style.setProperty('height', '80px');
  });
  const result = await probe.stop();
  expect(result.maxInputBottomChangePx).toBeGreaterThan(0);
  expect(result.samples.input).toBeGreaterThanOrEqual(2);
});

test('items are followed by value across node swaps; vanished values are lost', async ({
  page: tab,
}) => {
  await tab.setContent(page);
  const probe = createProbe(tab);
  await probe.start('swap');
  await tab.evaluate(() => {
    const b = document.querySelector('[data-chat-item="b"]');
    if (!b) throw new Error('missing item b');
    const fresh = b.cloneNode(true) as HTMLElement;
    fresh.style.marginLeft = '12px';
    fresh.style.marginTop = '5px';
    b.replaceWith(fresh);
    document.querySelector('[data-chat-item="c"]')?.remove();
  });
  const result = await probe.stop();
  const b = result.items.find((item) => item.id === 'data-chat-item=b');
  expect(b?.maxViewportShiftXPx).toBe(12);
  expect(b?.maxViewportShiftYPx).toBe(5);
  expect(result.lost).toEqual(['item data-chat-item=c']);
  expect(result.samples.tracked).toEqual({ item: 3, row: 0, part: 1 });
  expect(result.items.find((item) => item.kind === 'part')?.id).toBe(
    'data-chat-item=a/data-chat-part=p1',
  );
});

test('nothing tracked and no edges read as null, not 0', async ({ page: tab }) => {
  await tab.setContent('<p>empty</p>');
  const probe = createProbe(tab);
  await probe.start('empty');
  const result = await probe.stop();
  expect(result.maxContainerShiftPx).toBeNull();
  expect(result.maxViewportShiftPx).toBeNull();
  expect(result.maxTailGapChangePx).toBeNull();
  expect(result.maxInputBottomChangePx).toBeNull();
});

test('one loop per page, and none left after stop()', async ({ page: tab }) => {
  await tab.setContent(page);
  const first = createProbe(tab);
  await first.start('one');
  await expect(createProbe(tab).start('two')).rejects.toThrow(/already running/);
  await first.stop();
  expect(await tab.evaluate(() => '__flowProbe' in window)).toBe(false);
  const again = createProbe(tab);
  await again.start('three');
  await again.stop();
});

test('labels clipped by a scroll container are not counted', async ({ page: tab }) => {
  await tab.setContent(`
    <div style="height: 50px; overflow: hidden">
      <p data-presence-label style="height: 20px; margin: 0">Working</p>
      <p data-presence-label style="height: 20px; margin: 100px 0 0">Working</p>
    </div>
    <p data-presence-label style="visibility: hidden">Working</p>
    <p data-presence-label>Waiting</p>`);
  expect(await countVisibleLabels(tab)).toEqual({ Working: 1, Waiting: 1 });
});
