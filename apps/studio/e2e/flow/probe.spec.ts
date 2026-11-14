import { expect, type Page, test } from '@playwright/test';
import { countVisibleLabels, createProbe, duplicateLabels, waitForStill } from './probe.ts';

// The probe on small synthetic pages: no server, no app code.

/**
 * Wraps the page's requestAnimationFrame: `ran` counts the frame callbacks that ran, and while
 * held no callback runs; release() schedules the held ones. Call it before the probe starts.
 */
function frames(tab: Page) {
  return {
    install: (held: boolean) =>
      tab.evaluate((held) => {
        const original = window.requestAnimationFrame.bind(window);
        const control = { held, ran: 0, waiting: [] as FrameRequestCallback[] };
        (window as unknown as { __frames: typeof control }).__frames = control;
        window.requestAnimationFrame = (callback) => {
          if (control.held) {
            control.waiting.push(callback);
            return 0;
          }
          return original((time) => {
            control.ran += 1;
            callback(time);
          });
        };
        (window as unknown as { __release: () => void }).__release = () => {
          control.held = false;
          for (const callback of control.waiting.splice(0)) window.requestAnimationFrame(callback);
        };
      }, held),
    release: () => tab.evaluate(() => (window as unknown as { __release: () => void }).__release()),
    ran: () =>
      tab.evaluate(() => (window as unknown as { __frames: { ran: number } }).__frames.ran),
  };
}

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
  // No frame callback runs before the change, so only start() can have read the edge before it.
  const hold = frames(tab);
  await hold.install(true);
  const probe = createProbe(tab);
  await probe.start('immediate');
  await tab.evaluate(() => {
    document.querySelector('textarea')?.style.setProperty('height', '80px');
  });
  expect(await hold.ran()).toBe(0);
  await hold.release();
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
  // Moved on the frames after the swap; a never moved.
  expect(b?.framesMoved).toBeGreaterThan(0);
  expect(result.items.find((item) => item.id === 'data-chat-item=a')?.framesMoved).toBe(0);
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
  const counted = frames(tab);
  await counted.install(false);
  const first = createProbe(tab);
  await first.start('one');
  await expect(createProbe(tab).start('two')).rejects.toThrow(/already running/);
  await expect.poll(counted.ran).toBeGreaterThan(2);
  await first.stop();
  expect(await tab.evaluate(() => '__flowProbe' in window)).toBe(false);
  // The frame loop itself has stopped: no frame callback runs any more.
  const after = await counted.ran();
  await tab.waitForTimeout(300);
  expect(await counted.ran()).toBe(after);
  const again = createProbe(tab);
  await again.start('three');
  await again.stop();
});

test('elements sharing a value are tracked one by one', async ({ page: tab }) => {
  await tab.setContent(`
    <style>body { margin: 0 } div { height: 20px }</style>
    <ol><li data-chat-item="a">
      <div data-chat-part="body">first</div>
      <div data-chat-part="body">second</div>
    </li></ol>`);
  const probe = createProbe(tab);
  await probe.start('duplicates');
  await tab.evaluate(() => {
    const second = document.querySelectorAll<HTMLElement>('[data-chat-part="body"]')[1];
    if (!second) throw new Error('missing second part');
    second.style.transform = 'translateY(30px)';
  });
  const result = await probe.stop();
  const shift = (id: string) =>
    result.items.find((item) => item.id === id)?.maxContainerShiftYPx ?? null;
  expect(shift('data-chat-item=a/data-chat-part=body')).toBe(0);
  expect(shift('data-chat-item=a/data-chat-part=body#2')).toBe(30);
  expect(result.samples.tracked.part).toBe(2);
  expect(result.samples.duplicateIds).toBe(1);
  expect(result.duplicated).toEqual(['part data-chat-item=a/data-chat-part=body']);
});

test('a value shared only in the middle of an interval counts as a duplicate', async ({
  page: tab,
}) => {
  await tab.setContent(page);
  const probe = createProbe(tab);
  await probe.start('shared-later');
  // A second item with b's value comes and goes again before stop().
  await tab.evaluate(async () => {
    const copy = document.querySelector('[data-chat-item="b"]')?.cloneNode(true) as HTMLElement;
    document.querySelector('ol')?.append(copy);
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    copy.remove();
  });
  const result = await probe.stop();
  expect(result.samples.duplicateIds).toBe(1);
  expect(result.duplicated).toEqual(['item data-chat-item=b']);
});

test('the tail gap is measured from the last block the tail selector names', async ({
  page: tab,
}) => {
  await tab.setContent(page);
  const probe = createProbe(tab, { tailSelector: '[data-chat-item], [data-pending-tray]' });
  await probe.start('tray');
  // A block after the last item grows; the items do not move.
  await tab.evaluate(() => {
    const tray = document.createElement('div');
    tray.setAttribute('data-pending-tray', '');
    tray.style.height = '30px';
    document.querySelector('ol')?.append(tray);
  });
  const result = await probe.stop();
  expect(result.maxTailGapChangePx).toBe(30);
  expect(result.maxContainerShiftPx).toBe(0);
});

/** A page whose `moving` element shifts by 4px every 50ms, for `forMs` (or for good). */
function movingPage(moving: string, forMs?: number) {
  // The item is tall enough that a moving part stays inside it and moves nothing else.
  return `
    <style>[data-chat-item] { height: 80px }</style>
    <div data-testid="chat-timeline">
      <div data-chat-item="a"><div data-chat-part="body">a</div></div>
    </div>
    <nav>
      <a data-sidebar-index="0" href="#">project</a>
      <a data-session-row="s1" href="#">session</a>
    </nav>
    <div data-testid="chat-composer"><textarea></textarea></div>
    <script>
      const element = document.querySelector('${moving}');
      element.style.position = 'relative';
      let offset = 0;
      const timer = setInterval(() => {
        offset = (offset + 4) % 40;
        element.style.top = offset + 'px';
      }, 50);
      ${forMs === undefined ? '' : `setTimeout(() => clearInterval(timer), ${forMs});`}
    </script>`;
}

const brief = { stillMs: 300, timeoutMs: 1_500 };

test('waitForStill: a sidebar row still moving keeps it waiting', async ({ page: tab }) => {
  await tab.setContent(movingPage('[data-sidebar-index]'));
  await expect(waitForStill(tab, brief)).rejects.toThrow(/did not settle/);
});

test('waitForStill: a session row still moving keeps it waiting', async ({ page: tab }) => {
  await tab.setContent(movingPage('[data-session-row]'));
  await expect(waitForStill(tab, brief)).rejects.toThrow(/did not settle/);
});

test('waitForStill: a part still moving inside its item keeps it waiting', async ({
  page: tab,
}) => {
  await tab.setContent(movingPage('[data-chat-part]'));
  await expect(waitForStill(tab, brief)).rejects.toThrow(/did not settle/);
});

test('waitForStill: given selectors are the only ones watched', async ({ page: tab }) => {
  await tab.setContent(movingPage('[data-sidebar-index]'));
  await waitForStill(tab, { ...brief, selectors: ['[data-chat-item]'] });
});

test('waitForStill: nothing to watch is an error, not a still screen', async ({ page: tab }) => {
  await tab.setContent('<p>empty</p>');
  await expect(waitForStill(tab, brief)).rejects.toThrow(/no element matches/);
});

test('waitForStill: a screen that stops after 1.2s passes', async ({ page: tab }) => {
  await tab.setContent(movingPage('[data-chat-item]', 1_200));
  const started = Date.now();
  await waitForStill(tab);
  // It waited out the motion and then the default 2s of stillness.
  expect(Date.now() - started).toBeGreaterThanOrEqual(1_200 + 2_000 - 500);
});

test('labels are counted by the target they speak of, with their texts', async ({ page: tab }) => {
  await tab.setContent(`
    <p data-presence-label="run:a">Working</p>
    <p data-presence-label="run:a">Working</p>
    <p data-presence-label="run:b">Working</p>
    <p data-presence-label="execution:x">Waiting</p>`);
  expect(await countVisibleLabels(tab)).toEqual({
    labels: {
      'run:a': { count: 2, texts: ['Working', 'Working'] },
      'run:b': { count: 1, texts: ['Working'] },
      'execution:x': { count: 1, texts: ['Waiting'] },
    },
    unkeyed: 0,
  });
  // The same text for different targets is not a duplicate.
  expect(await duplicateLabels(tab)).toEqual({
    'run:a': { count: 2, texts: ['Working', 'Working'] },
  });
});

test('labels clipped by a scroll container or hidden are not counted', async ({ page: tab }) => {
  await tab.setContent(`
    <div style="height: 50px; overflow: hidden">
      <p data-presence-label="run:a" style="height: 20px; margin: 0">Working</p>
      <p data-presence-label="run:a" style="height: 20px; margin: 100px 0 0">Working</p>
    </div>
    <p data-presence-label="run:b" style="visibility: hidden">Working</p>
    <p data-presence-label="execution:x">Waiting</p>`);
  expect(await countVisibleLabels(tab)).toEqual({
    labels: {
      'run:a': { count: 1, texts: ['Working'] },
      'execution:x': { count: 1, texts: ['Waiting'] },
    },
    unkeyed: 0,
  });
  expect(await duplicateLabels(tab)).toEqual({});
});

test('labels without a value are counted apart as unkeyed', async ({ page: tab }) => {
  await tab.setContent(`
    <p data-presence-label>Working</p>
    <p data-presence-label="">Working</p>
    <p data-presence-label="run:a">Working</p>`);
  expect(await countVisibleLabels(tab)).toEqual({
    labels: { 'run:a': { count: 1, texts: ['Working'] } },
    unkeyed: 2,
  });
  expect(await duplicateLabels(tab)).toEqual({});
});
