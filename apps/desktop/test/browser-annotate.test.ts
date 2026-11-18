// The annotation mode's main side (features/browser-annotate.md): the overlay view, the page
// reads with their limit, the preview rules, and a note's way to the app page.
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { OVERLAY_CSP, OVERLAY_URL, overlayResource } from '../src/annotate-overlay.ts';
import { movesGeneration } from '../src/browser-annotate.ts';
import { FakeContents, type FakeSession, fakeImage, setup } from './browser-fakes.ts';

type Ops = Record<string, (args: Record<string, unknown>) => unknown>;
const flush = () => new Promise((done) => setTimeout(done, 0));

/** The page agent's stand-in: answers each call by its operation and records it. */
function agent(page: FakeContents, ops: Ops) {
  const calls: [string, Record<string, unknown>][] = [];
  page.executeJavaScriptInIsolatedWorld.mockImplementation(
    async (world: number, scripts: { code: string }[]) => {
      expect(world).toBe(1002);
      const code = scripts[0]?.code ?? '';
      const short = /\?__corralAnnotateAgent\((.*)\):"__corral/s.exec(code);
      const full = /\)\(("[a-z]+",.*)\)$/s.exec(code);
      const [op, args] = JSON.parse(`[${short?.[1] ?? full?.[1]}]`) as [
        string,
        Record<string, unknown>,
      ];
      calls.push([op, args]);
      const handler = ops[op];
      if (handler) return handler(args);
      return ['probe', 'reset', 'clear', 'release'].includes(op) ? true : null;
    },
  );
  return calls;
}

const element = {
  tag: 'button',
  role: null,
  selector: 'main:nth-of-type(1) > button:nth-of-type(1)',
  text: 'Pay',
  bounds: { x: 20, y: 30, width: 120, height: 32 },
  styles: { color: 'rgb(0, 0, 0)' },
};
const found = (overrides: Record<string, unknown> = {}) => ({
  pickId: 'ignored',
  label: 'button.pay 120×32',
  name: 'Pay now',
  box: { x: 20, y: 30, width: 120, height: 32 },
  element,
  screenshotAllowed: true,
  ...overrides,
});

async function annotated(ops: Ops = {}, address = 'https://example.com/shop?q=secret#top') {
  const f = setup();
  f.tabs.navigate('tab-a', 'project_a', address);
  const pageView = f.views[0];
  if (!pageView) throw new Error('no page view');
  const page = pageView.webContents;
  page.commit(address);
  f.tabs.place('tab-a', { x: 10, y: 50, width: 800, height: 600 });
  const calls = agent(page, {
    pick: () => found(),
    shot: () => ({
      bounds: { x: 20, y: 30, width: 120, height: 32 },
      safe: true,
      selector: ':root > :nth-child(2) > :nth-child(1)',
    }),
    rule: () => ({ selector: ':root > :nth-child(2) > :nth-child(1)' }),
    ...ops,
  });
  expect(f.tabs.annotate('tab-a', true)).toBe(true);
  const view = f.views[1];
  if (!view) throw new Error('no overlay view');
  const overlay = view.webContents;
  overlay.mainFrame.url = OVERLAY_URL;
  overlay.emit('did-finish-load');
  const call = (name: string, ...args: unknown[]) =>
    f.tabs.fromOverlay(overlay as never, overlay.mainFrame as never, name, args);
  const told = () =>
    overlay.send.mock.calls
      .filter((entry) => entry[0] === 'annotate:event')
      .map((entry) => entry[1]);
  const app = (type: string) => f.events.filter((event) => event.type === type);
  return { f, page, pageView, view, overlay, call, told, calls, app };
}

it('the mode puts a transparent overlay over the live page, from its own partition and preload', async () => {
  const { f, pageView, view, overlay, told, app } = await annotated();
  const init = view.init as { session: FakeSession; webPreferences: Record<string, unknown> };
  expect(init.session.name).toBe('corral-annotate'); // in memory, not persist:corral or a project's
  expect(init.webPreferences).toMatchObject({
    preload: '/app/dist/annotate-preload.cjs',
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
  });
  expect(view.setBackgroundColor).toHaveBeenCalledWith('#00000000');
  expect(overlay.loadURL).toHaveBeenCalledWith(OVERLAY_URL);
  expect(view.bounds).toEqual(pageView.bounds);
  expect([...f.children].indexOf(view as never)).toBeGreaterThan(
    [...f.children].indexOf(pageView as never),
  );
  expect(overlay.setZoomFactor).toHaveBeenCalledWith(1.25); // the app's zoom
  expect(overlay.focus).toHaveBeenCalled();
  expect(told()).toEqual([{ type: 'page', kind: 'page', generation: 1 }, { type: 'focus' }]);
  expect(app('annotate')).toEqual([{ type: 'annotate', tabId: 'tab-a', on: true }]);
  // Asked again: the same overlay.
  expect(f.tabs.annotate('tab-a', true)).toBe(true);
  expect(f.views).toHaveLength(2);
});

it('no mode without a page to show', () => {
  const f = setup();
  expect(f.tabs.annotate('tab-x', true)).toBe(false);
  f.tabs.navigate('tab-a', 'project_a', 'https://example.com/');
  expect(f.tabs.annotate('tab-a', true)).toBe(false); // not placed
  f.tabs.place('tab-a', { x: 0, y: 0, width: 100, height: 100 });
  f.views[0]?.webContents.fail('https://example.com/', -105);
  expect(f.tabs.annotate('tab-a', true)).toBe(false); // failed page
  expect(f.views).toHaveLength(1);
});

it('the overlay partition serves only the overlay files, cancels any other request and grants nothing', async () => {
  const { f } = await annotated();
  const session = f.sessions.get('corral-annotate') as FakeSession;
  const serve = session.protocols.get('corral-overlay');
  if (!serve) throw new Error('no overlay protocol');
  const page = serve({ url: OVERLAY_URL, method: 'GET' });
  expect(page.status).toBe(200);
  expect(page.headers.get('content-security-policy')).toBe(OVERLAY_CSP);
  expect(page.headers.get('content-type')).toMatch(/^text\/html/);
  expect(await page.text()).toBe('file:annotate.html');
  for (const url of [
    'corral-overlay://overlay/index.html',
    'corral-overlay://overlay/assets/../index.html',
    'corral-overlay://overlay/assets/missing.js',
    'corral-overlay://other/annotate.html',
  ])
    expect(serve({ url, method: 'GET' }).status, url).toBe(404);
  expect(serve({ url: OVERLAY_URL, method: 'POST' }).status).toBe(404);
  const cancel = (url: string) => {
    let answer: boolean | undefined;
    session.beforeRequest?.({ url }, (result) => {
      answer = result.cancel;
    });
    return answer;
  };
  expect(cancel('https://example.com/collect')).toBe(true);
  expect(cancel('ws://127.0.0.1:4000/')).toBe(true);
  expect(cancel('http://127.0.0.1:5173/api/sessions')).toBe(true); // not Corral's server either
  expect(cancel(`${OVERLAY_URL}`)).toBe(false);
  let allowed: boolean | undefined;
  session.requestHandler?.({}, 'media', (allow: boolean) => {
    allowed = allow;
  });
  expect(allowed).toBe(false);
  expect(session.checkHandler?.({}, 'clipboard-read', 'corral-overlay://overlay', {})).toBe(false);
  expect(session.setSpellCheckerEnabled).toHaveBeenCalledWith(false);
  // The CSP lets the overlay reach nothing outside itself.
  expect(OVERLAY_CSP).toMatch(/connect-src 'none'/);
  expect(OVERLAY_CSP).toMatch(/script-src 'self'(;|$)/);
});

it('overlay URLs name only the overlay page and its assets', () => {
  expect(overlayResource('corral-overlay://overlay/annotate.html')?.path).toBe('annotate.html');
  expect(overlayResource('corral-overlay://overlay/assets/annotate-Bx1.js')).toEqual({
    path: 'assets/annotate-Bx1.js',
    type: 'text/javascript; charset=utf-8',
  });
  // What the studio's build holds today: scripts, styles and its fonts.
  for (const name of ['index-1.css', 'Inter-2.woff2', 'Mono-3.ttf'])
    expect(overlayResource(`corral-overlay://overlay/assets/${name}`), name).not.toBeNull();
  for (const url of [
    'corral-overlay://overlay/assets/%2e%2e/secret.js',
    'corral-overlay://overlay/assets/a/../../x.js',
    'corral-overlay://overlay/assets/page.html',
    'corral-overlay://overlay/assets/x.exe',
    'corral-overlay://user:pw@overlay/annotate.html',
    'corral://startup/annotate.html',
    'not a url',
  ])
    expect(overlayResource(url), url).toBeNull();
});

it('only the overlay of that tab may call, from its main frame on the overlay page', async () => {
  const { f, page, overlay } = await annotated();
  const app = new FakeContents(); // the app's own page, say
  for (const [sender, frame] of [
    [page, page.mainFrame],
    [app, app.mainFrame],
    [overlay, { url: OVERLAY_URL }], // not its main frame
    [overlay, null],
  ] as const)
    await expect(f.tabs.fromOverlay(sender as never, frame as never, 'end', [])).rejects.toThrow(
      'Untrusted',
    );
  overlay.mainFrame.url = 'https://example.com/';
  await expect(
    f.tabs.fromOverlay(overlay as never, overlay.mainFrame as never, 'end', []),
  ).rejects.toThrow('Untrusted');
  overlay.mainFrame.url = OVERLAY_URL;
  await expect(
    f.tabs.fromOverlay(overlay as never, overlay.mainFrame as never, 'eval', []),
  ).rejects.toThrow();
});

it("the overlay never moves or opens a window, and its keys are the tab's", async () => {
  const { f, page, overlay } = await annotated();
  let prevented = 0;
  const stop = { preventDefault: () => prevented++ };
  overlay.emit('will-navigate', stop);
  overlay.emit('will-redirect', stop);
  expect(prevented).toBe(2);
  expect(overlay.open('https://example.com/')).toEqual({ action: 'deny' });
  overlay.key({ key: 'r', code: 'KeyR', control: true });
  expect(page.reload).toHaveBeenCalledTimes(1); // Mod+R reloads the page, not the overlay
  overlay.key({ key: 'Escape', code: 'Escape', shift: true });
  expect(f.events.at(-1)).toEqual({ type: 'leave', tabId: 'tab-a' });
  expect(overlay.reload).not.toHaveBeenCalled();
});

it('frame reads convert between the overlay and the page, both zooms counted', async () => {
  const { page, call, calls } = await annotated({
    pick: () => found(),
    frame: () => ({
      hover: { label: 'p 100×20', name: null, box: { x: 30, y: 60, width: 100, height: 20 } },
      boxes: { [pickId]: { x: 15, y: 45, width: 60, height: 30 } },
      view: { width: 500, height: 300 },
    }),
  });
  let pickId = '';
  page.zoomFactor = 1.5; // the page's zoom; the app's is 1.25
  const picked = (await call('pick', { x: 24, y: 36 })) as {
    ok: true;
    pick: { pickId: string; box: unknown };
  };
  pickId = picked.pick.pickId;
  expect(calls.at(-1)).toEqual(['pick', { x: 20, y: 30, pickId }]);
  expect(picked.pick.box).toEqual({ x: 24, y: 36, width: 144, height: 38.4 });
  expect((picked.pick as unknown as { page: unknown }).page).toEqual({
    kind: 'page',
    origin: 'https://example.com',
    path: '/shop',
  });
  const frame = await call('frame', { pointer: { x: 120, y: 60 }, track: [pickId, 'unknown'] });
  expect(calls.at(-1)).toEqual(['frame', { pointer: { x: 100, y: 50 }, ids: [pickId] }]);
  expect(frame).toEqual({
    hover: { label: 'p 100×20', name: null, box: { x: 36, y: 72, width: 120, height: 24 } },
    boxes: { [pickId]: { x: 18, y: 54, width: 72, height: 36 }, unknown: null },
    // The page's scroll area, without its scrollbars, in the overlay's pixels.
    view: { width: 600, height: 360 },
  });
});

it('one read at a time: a frame read while another is out answers null at once', async () => {
  let finish!: (value: unknown) => void;
  const { call, calls } = await annotated({
    walk: () =>
      new Promise((done) => {
        finish = done;
      }),
  });
  const walking = call('walk', 'down');
  await flush();
  expect(await call('frame', { pointer: null, track: [] })).toBeNull();
  expect(calls.filter(([op]) => op === 'frame')).toHaveLength(0);
  finish({ label: 'div 10×10', name: null, box: { x: 0, y: 0, width: 10, height: 10 } });
  expect(await walking).toMatchObject({ label: 'div 10×10' });
});

it('a page that stops answering: reads give up after 1,000 ms and the overlay is told, until it answers again', async () => {
  let release!: (value: unknown) => void;
  const { f, page, call, calls, told } = await annotated({
    walk: () =>
      new Promise((done) => {
        release = done;
      }),
    probe: () => new Promise(() => {}),
  });
  const walking = call('walk', 'up');
  await flush();
  f.advance(999);
  await flush();
  expect(told()).not.toContainEqual({ type: 'page-busy', busy: true });
  f.advance(1);
  expect(await walking).toBeNull();
  expect(told()).toContainEqual({ type: 'page-busy', busy: true });
  // Meanwhile nothing more goes to the page: reads answer at once, a wheel is dropped.
  const before = calls.length;
  expect(await call('frame', { pointer: { x: 1, y: 1 }, track: [] })).toBeNull();
  expect(await call('pick', { x: 1, y: 1 })).toEqual({ ok: false, reason: 'page-busy' });
  await call('wheel', { x: 1, y: 1, deltaX: 0, deltaY: 100, deltaMode: 0 });
  expect(page.sendInputEvent).not.toHaveBeenCalled();
  expect(calls.slice(before).filter(([op]) => op !== 'probe')).toEqual([]);
  // The late answer is the page answering again; it isn't used.
  release({ label: 'late', name: null, box: { x: 0, y: 0, width: 1, height: 1 } });
  await flush();
  expect(told().at(-1)).toEqual({ type: 'page-busy', busy: false });
});

it("a stalled read that never answers: the probe's answer, or a new document, ends the busy line", async () => {
  let probe!: (value: unknown) => void;
  const { f, page, call, told } = await annotated({
    inspect: () => new Promise(() => {}),
    probe: () =>
      new Promise((done) => {
        probe = done;
      }),
  });
  const picked = (await call('pick', { x: 1, y: 1 })) as { pick: { pickId: string } };
  const waiting = call('inspect', picked.pick.pickId);
  await flush();
  f.advance(1000);
  expect(await waiting).toBeNull();
  await flush();
  probe(true);
  await flush();
  expect(told().at(-1)).toEqual({ type: 'page-busy', busy: false });
  // Again, and this time the page moves on instead.
  const second = call('inspect', picked.pick.pickId);
  await flush();
  f.advance(1000);
  await second;
  expect(told().at(-1)).toEqual({ type: 'page-busy', busy: true });
  const before = told().length;
  page.commit('https://example.com/next');
  expect(told().slice(before)).toContainEqual({ type: 'page-busy', busy: false });
  expect(told().at(-1)).toEqual({ type: 'page', kind: 'page', generation: 2 });
});

it('a pick across a navigation is refused; one the agent finds nothing for is nothing', async () => {
  let answer!: (value: unknown) => void;
  const { page, call } = await annotated({
    pick: () =>
      new Promise((done) => {
        answer = done;
      }),
  });
  const picking = call('pick', { x: 5, y: 5 });
  await flush();
  page.commit('https://example.com/other');
  answer(found());
  expect(await picking).toEqual({ ok: false, reason: 'page-changed' });
  const nothing = call('pick', 'outline');
  await flush();
  answer(null);
  expect(await nothing).toEqual({ ok: false, reason: 'nothing' });
});

it('what moves the generation: documents and routes, not fragments', () => {
  expect(movesGeneration('document', 'https://a.example/x', 'https://a.example/x')).toBe(true);
  expect(movesGeneration('in-page', 'https://a.example/x#one', 'https://a.example/x#two')).toBe(
    false,
  );
  expect(movesGeneration('in-page', 'https://a.example/x', 'https://a.example/y')).toBe(true);
  expect(movesGeneration('in-page', 'https://a.example/x?a=1', 'https://a.example/x?a=2')).toBe(
    true,
  );
});

it("a route change in the page drops its picks and Corral's rules; a fragment change keeps them", async () => {
  const { page, call, calls, told } = await annotated();
  const picked = (await call('pick', { x: 1, y: 1 })) as { pick: { pickId: string } };
  const pickId = picked.pick.pickId;
  expect(await call('preview', pickId, 'color', 'red')).toEqual({ ok: true });
  await flush();
  expect(page.css.size).toBe(1);
  page.emit('did-navigate-in-page', {}, 'https://example.com/shop?q=secret#other', true);
  expect(page.css.size).toBe(1);
  expect(await call('inspect', pickId)).toBeNull(); // the agent answers null to inspect here
  page.emit('did-navigate-in-page', {}, 'https://example.com/cart', true);
  await flush();
  expect(page.css.size).toBe(0);
  expect(calls.some(([op]) => op === 'clear')).toBe(true);
  expect(told()).toContainEqual({ type: 'navigated', generation: 2 });
  expect(await call('preview', pickId, 'color', 'blue')).toEqual({
    ok: false,
    reason: 'page-changed',
  });
  // A subframe's move is nothing.
  page.emit('did-navigate-in-page', {}, 'https://ads.example/frame', false);
  expect(told()).not.toContainEqual({ type: 'navigated', generation: 3 });
});

it("preview rules: an !important rule on the pick's selector, outranking the page's IDs, one per property", async () => {
  const { page, call, calls } = await annotated();
  const { pick } = (await call('pick', { x: 1, y: 1 })) as { pick: { pickId: string } };
  expect(await call('preview', pick.pickId, 'color', 'var(--brand)')).toEqual({ ok: true });
  await flush();
  expect(calls.at(-1)).toEqual([
    'rule',
    { pickId: pick.pickId, property: 'color', value: 'var(--brand)' },
  ]);
  // Author origin: a user-origin sheet can't be taken off again.
  expect(page.insertCSS).toHaveBeenLastCalledWith(
    ':root > :nth-child(2) > :nth-child(1):not(#\\#c1):not(#\\#c2):not(#\\#c3) { color: var(--brand) !important; }',
    { cssOrigin: 'author' },
  );
  const [first] = [...page.css.keys()];
  expect(await call('preview', pick.pickId, 'color', 'red')).toEqual({ ok: true });
  await flush();
  expect([...page.css.values()]).toEqual([
    ':root > :nth-child(2) > :nth-child(1):not(#\\#c1):not(#\\#c2):not(#\\#c3) { color: red !important; }',
  ]);
  expect(page.css.has(first as string)).toBe(false);
  expect(await call('preview', pick.pickId, 'color', null)).toEqual({ ok: true });
  await flush();
  expect(page.css.size).toBe(0);
  // A value that could leave its declaration never reaches the page.
  const before = calls.length;
  expect(await call('preview', pick.pickId, 'color', 'red; } body { display: none')).toEqual({
    ok: false,
    reason: 'invalid',
  });
  expect(calls.length).toBe(before);
  await expect(call('preview', pick.pickId, 'content', 'x')).rejects.toThrow();
});

it('the page refusing a value is invalid; a rule landing after its limit or its release comes out', async () => {
  let land!: (key: string) => void;
  const { f, page, call } = await annotated({
    rule: (args) => (args.value === 'nope' ? 'invalid' : { selector: ':root > :nth-child(2)' }),
  });
  const { pick } = (await call('pick', { x: 1, y: 1 })) as { pick: { pickId: string } };
  expect(await call('preview', pick.pickId, 'width', 'nope')).toEqual({
    ok: false,
    reason: 'invalid',
  });
  page.insertCSS.mockImplementationOnce(
    (css: string) =>
      new Promise((done) => {
        land = (key) => {
          page.css.set(key, css);
          done(key);
        };
      }),
  );
  const slow = call('preview', pick.pickId, 'width', '10px');
  await flush();
  f.advance(1000);
  expect(await slow).toEqual({ ok: false, reason: 'page-busy' });
  land('late-key');
  await flush();
  expect(page.removeInsertedCSS).toHaveBeenCalledWith('late-key');
  expect(page.css.size).toBe(0);
  // After the page answers again: release takes a pick's rules off.
  await flush();
  expect(await call('preview', pick.pickId, 'height', '20px')).toEqual({ ok: true });
  await flush();
  expect(page.css.size).toBe(1);
  await call('release', pick.pickId);
  await flush();
  expect(page.css.size).toBe(0);
  expect(await call('inspect', pick.pickId)).toBeNull(); // forgotten
});

it("wheels scroll the page: the DOM's deltas, sign flipped, in DIP", async () => {
  const { page, call } = await annotated();
  await call('wheel', { x: 100, y: 40, deltaX: 0, deltaY: 120, deltaMode: 0 });
  expect(page.sendInputEvent).toHaveBeenLastCalledWith({
    type: 'mouseWheel',
    x: 125,
    y: 50,
    deltaX: -0,
    deltaY: -150,
    canScroll: true,
  });
  await call('wheel', { x: 0, y: 0, deltaX: 2, deltaY: 0, deltaMode: 1 });
  expect(page.sendInputEvent).toHaveBeenLastCalledWith(
    expect.objectContaining({ deltaX: -100, deltaY: -0 }),
  );
  await expect(
    call('wheel', { x: 0, y: 0, deltaX: 0, deltaY: 1, deltaMode: 0, shift: true }),
  ).rejects.toThrow();
  await expect(
    call('wheel', { x: 0, y: 0, deltaX: Number.NaN, deltaY: 1, deltaMode: 0 }),
  ).rejects.toThrow();
});

const note = (pickId: string, overrides: Record<string, unknown> = {}) => ({
  noteId: 'note-1',
  pickId,
  intent: 'send',
  text: '버튼을 더 크게',
  styles: [{ property: 'font-size', before: '14px', after: '18px' }],
  screenshot: true,
  console: false,
  extra: { key: 'enter' },
  ...overrides,
});

it("a send: re-checked, its screenshot taken, the material to the app page, and the app's answer back", async () => {
  const { f, page, call, app } = await annotated();
  page.zoomFactor = 1.5;
  const png = Buffer.from('a-small-png');
  page.capturePage.mockResolvedValueOnce(fakeImage(180, 48, png) as never);
  const { pick } = (await call('pick', { x: 1, y: 1 })) as { pick: { pickId: string } };
  f.advance(5000);
  const sending = call('submit', note(pick.pickId));
  await flush();
  await flush();
  // The element's part, in the page view's DIP.
  expect(page.capturePage).toHaveBeenLastCalledWith({ x: 30, y: 45, width: 180, height: 48 });
  const [submitted] = app('annotate-submit');
  expect(submitted).toEqual({
    type: 'annotate-submit',
    tabId: 'tab-a',
    submitId: expect.any(String),
    noteId: 'note-1',
    intent: 'send',
    extra: { key: 'enter' },
    material: {
      page: { kind: 'page', origin: 'https://example.com', path: '/shop' },
      pickedAt: new Date(10_000).toISOString(),
      generation: 1,
      pickId: pick.pickId,
      note: '버튼을 더 크게',
      element: expect.objectContaining({
        tag: 'button',
        bounds: { x: 20, y: 30, width: 120, height: 32 },
      }),
      styles: [{ property: 'font-size', before: '14px', after: '18px' }],
      console: null,
      screenshot: {
        mime: 'image/png',
        data: png.toString('base64'),
        width: 180,
        height: 48,
        sha256: createHash('sha256').update(png).digest('hex'),
      },
    },
  });
  expect(JSON.stringify(submitted)).not.toMatch(/secret|#top/);
  const submitId = (submitted as { submitId: string }).submitId;
  f.tabs.answerAnnotate('tab-a', 'someone-else', { kind: 'accepted' });
  f.tabs.answerAnnotate('tab-a', submitId, { kind: 'accepted', commandId: 'c1' });
  expect(await sending).toEqual({
    kind: 'answered',
    outcome: { kind: 'accepted', commandId: 'c1' },
  });
  // A second answer is late and goes nowhere.
  f.tabs.answerAnnotate('tab-a', submitId, { kind: 'refused' });
});

it('a send that would be wrong is refused before it leaves: changed, not visible, input fields, too big, busy', async () => {
  let shot: unknown = null;
  const { f, page, call, app } = await annotated({ shot: () => shot });
  const pickOne = async () =>
    ((await call('pick', { x: 1, y: 1 })) as { pick: { pickId: string } }).pick.pickId;
  // The page moved since the pick.
  let pickId = await pickOne();
  page.commit('https://example.com/elsewhere');
  expect(await call('submit', note(pickId))).toEqual({ kind: 'page-changed' });
  pickId = await pickOne();
  expect(await call('submit', note(pickId))).toEqual({ kind: 'not-visible' });
  shot = {
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    safe: false,
    selector: ':root > :nth-child(2)',
  };
  expect(await call('submit', note(pickId))).toEqual({ kind: 'input-fields' });
  shot = {
    bounds: { x: 0, y: 0, width: 3000, height: 10 },
    safe: true,
    selector: ':root > :nth-child(2)',
  };
  expect(await call('submit', note(pickId))).toEqual({ kind: 'image-limit' });
  shot = {
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    safe: true,
    selector: ':root > :nth-child(2)',
  };
  page.capturePage.mockResolvedValueOnce(fakeImage(10, 10, Buffer.alloc(1024 * 1024 + 1)) as never);
  expect(await call('submit', note(pickId))).toEqual({ kind: 'image-limit' });
  page.capturePage.mockImplementationOnce(() => new Promise(() => {}));
  const busy = call('submit', note(pickId));
  await flush();
  await flush();
  f.advance(1000);
  expect(await busy).toEqual({ kind: 'page-busy' });
  expect(app('annotate-submit')).toEqual([]);
});

it('screenshot off: an element with input fields is sent without one', async () => {
  const { call, app, page } = await annotated({
    shot: () => ({
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      safe: false,
      selector: ':root > :nth-child(2)',
    }),
  });
  const { pick } = (await call('pick', { x: 1, y: 1 })) as { pick: { pickId: string } };
  void call('submit', note(pick.pickId, { screenshot: false }));
  await flush();
  await flush();
  expect(page.capturePage).not.toHaveBeenCalled();
  expect(app('annotate-submit')[0]).toMatchObject({ material: { screenshot: null } });
});

it("a preview tab's send: the lease again, the address inside it, the console when asked, no token anywhere", async () => {
  const f = setup();
  await f.tabs.openPreview('tab-p', 'session_1', 'lease_1');
  const page = f.views[0]?.webContents as FakeContents;
  page.commit('http://127.0.0.2:4321/key-path/settings?tab=2');
  f.tabs.place('tab-p', { x: 0, y: 0, width: 800, height: 600 });
  agent(page, {
    pick: () => found({ element: { ...element, text: 'Open /key-path/admin with lease-token' } }),
    shot: () => ({ bounds: element.bounds, safe: true, selector: ':root > :nth-child(2)' }),
  });
  expect(f.tabs.annotate('tab-p', true)).toBe(true);
  const overlay = f.views[1]?.webContents as FakeContents;
  overlay.mainFrame.url = OVERLAY_URL;
  overlay.emit('did-finish-load');
  const call = (name: string, ...args: unknown[]) =>
    f.tabs.fromOverlay(overlay as never, overlay.mainFrame as never, name, args);
  for (let i = 0; i < 25; i++)
    page.emit('console-message', { level: 'warning', message: `line ${i} lease-token` });
  const { pick } = (await call('pick', { x: 1, y: 1 })) as {
    pick: { pickId: string; page: unknown; element: { text: string } };
  };
  // The overlay shows the note as it will go: the page inside the lease, the text without its token.
  expect(pick.page).toEqual({
    kind: 'preview',
    origin: 'http://127.0.0.2:4321',
    path: '/settings',
  });
  expect(pick.element.text).not.toMatch(/lease-token|key-path/);
  void call('submit', note(pick.pickId, { console: true, screenshot: false }));
  await flush();
  await flush();
  const submitted = f.events.find((event) => event.type === 'annotate-submit') as {
    material: { page: unknown; console: { message: string }[]; element: { text: string } };
  };
  expect(submitted.material.page).toEqual({
    kind: 'preview',
    sessionId: 'session_1',
    leaseId: 'lease_1',
    origin: 'http://127.0.0.2:4321',
    path: '/settings',
  });
  expect(submitted.material.console).toHaveLength(20);
  expect(submitted.material.console[0]?.message).toBe('line 5 [redacted]');
  expect(JSON.stringify(submitted)).not.toMatch(/lease-token|key-path/);
  // The lease changed meanwhile: nothing is sent.
  f.ports.resolveLease.mockResolvedValueOnce({
    ...f.lease,
    headers: { 'x-corral-preview': 'another-token' },
  });
  expect(await call('submit', note(pick.pickId, { noteId: 'note-2', screenshot: false }))).toEqual({
    kind: 'page-changed',
  });
  // The console starts again with the next page.
  page.commit('http://127.0.0.2:4321/key-path/next');
  const again = (await call('pick', { x: 1, y: 1 })) as { pick: { pickId: string } };
  void call(
    'submit',
    note(again.pick.pickId, { noteId: 'note-3', console: true, screenshot: false }),
  );
  await flush();
  await flush();
  const last = f.events.filter((event) => event.type === 'annotate-submit').at(-1) as {
    material: { console: unknown[] };
  };
  expect(last.material.console).toEqual([]);
});

it('cancelling: before the app page has it nothing goes; after, the app is told and a late answer is dropped', async () => {
  let shot!: (value: unknown) => void;
  const { f, call, app } = await annotated({
    shot: () =>
      new Promise((done) => {
        shot = done;
      }),
  });
  const { pick } = (await call('pick', { x: 1, y: 1 })) as { pick: { pickId: string } };
  const early = call('submit', note(pick.pickId, { screenshot: false }));
  await flush();
  await call('cancel-submit', 'note-1');
  expect(await early).toEqual({ kind: 'cancelled' });
  shot({ bounds: element.bounds, safe: true, selector: ':root > :nth-child(2)' });
  await flush();
  expect(app('annotate-submit')).toEqual([]);
  const late = call('submit', note(pick.pickId, { screenshot: false, intent: 'add' }));
  await flush();
  shot({ bounds: element.bounds, safe: true, selector: ':root > :nth-child(2)' });
  await flush();
  await flush();
  const [submitted] = app('annotate-submit') as { submitId: string }[];
  await call('cancel-submit', 'note-1');
  expect(app('annotate-cancel')).toEqual([
    { type: 'annotate-cancel', tabId: 'tab-a', submitId: submitted?.submitId },
  ]);
  expect(await late).toEqual({ kind: 'cancelled' });
  f.tabs.answerAnnotate('tab-a', submitted?.submitId as string, { kind: 'added' });
});

it('turning it off: the app hears at once, the overlay plays its exit, then everything Corral put in comes out', async () => {
  const { f, page, view, overlay, call, told, calls, app } = await annotated();
  const { pick } = (await call('pick', { x: 1, y: 1 })) as { pick: { pickId: string } };
  await call('preview', pick.pickId, 'color', 'red');
  await flush();
  overlay.emit('focus'); // the keyboard is in the overlay
  expect(f.tabs.annotate('tab-a', false)).toBe(false);
  expect(app('annotate').at(-1)).toEqual({ type: 'annotate', tabId: 'tab-a', on: false });
  expect(told().at(-1)).toEqual({ type: 'ending' });
  expect(f.children.has(view as never)).toBe(true); // still playing its exit
  expect(await call('frame', { pointer: null, track: [] })).toBeNull();
  await call('ended');
  expect(f.children.has(view as never)).toBe(false);
  expect(overlay.close).toHaveBeenCalled();
  expect(page.css.size).toBe(0);
  expect(calls.at(-1)?.[0]).toBe('reset');
  expect(page.focus).toHaveBeenCalled();
  expect(app('annotate').filter((event) => !(event as { on: boolean }).on)).toHaveLength(1);
  await expect(call('end')).rejects.toThrow();
});

it("an exit that doesn't finish is cut after 600 ms; Escape at the outermost level ends it the same way", async () => {
  const { f, view, call, told } = await annotated();
  await call('end');
  expect(told().at(-1)).toEqual({ type: 'ending' });
  f.advance(599);
  expect(f.children.has(view as never)).toBe(true);
  f.advance(1);
  expect(f.children.has(view as never)).toBe(false);
});

it('the mode ends at once when the page stops showing', async () => {
  const cases: [string, (t: Awaited<ReturnType<typeof annotated>>) => void | Promise<void>][] = [
    ['hidden', (t) => t.f.tabs.place('tab-a', null)],
    ['failed', (t) => t.page.fail('https://example.com/down', -105)],
    ['crashed', (t) => void t.page.emit('render-process-gone', {}, { reason: 'crashed' })],
    ['closed itself', (t) => t.page.destroy()],
    ['unloaded', (t) => t.f.tabs.unload('tab-a')],
    ['closed', (t) => t.f.tabs.close('tab-a')],
    [
      'overlay crashed',
      (t) => void t.overlay.emit('render-process-gone', {}, { reason: 'crashed' }),
    ],
  ];
  for (const [name, end] of cases) {
    const t = await annotated();
    await end(t);
    expect(t.f.children.has(t.view as never), name).toBe(false);
    expect(t.app('annotate').at(-1), name).toEqual({ type: 'annotate', tabId: 'tab-a', on: false });
    expect(t.told(), name).not.toContainEqual({ type: 'ending' });
  }
});

it('the overlap still: both pictures; freezing hides both views and thawing brings back the same overlay', async () => {
  const { f, pageView, view, overlay, app } = await annotated();
  overlay.capturePage.mockResolvedValueOnce({
    ...fakeImage(1000, 750),
    toDataURL: () => 'data:image/png;base64,overlay',
  } as never);
  const still = await f.tabs.still('tab-a');
  expect(still?.overlay).toEqual({
    dataUrl: 'data:image/png;base64,overlay',
    width: 1000,
    height: 750,
  });
  expect(f.tabs.freeze('tab-a', still?.stillId as string)).toBe(true);
  expect([pageView.visible, view.visible]).toEqual([false, false]);
  f.tabs.thaw('tab-a');
  expect([pageView.visible, view.visible]).toEqual([true, true]);
  expect(f.views).toHaveLength(2);
  expect(app('annotate')).toHaveLength(1); // still on
  // A picture of the overlay that fails: no still, the views stay live.
  overlay.capturePage.mockRejectedValueOnce(new Error('no'));
  expect(await f.tabs.still('tab-a')).toBeNull();
});

it('picks outlive turning the mode off and on in one page, not a move to another', async () => {
  const t = await annotated({
    frame: (args) => ({
      hover: null,
      boxes: Object.fromEntries(
        (args.ids as string[]).map((one) => [one, { x: 0, y: 0, width: 5, height: 5 }]),
      ),
    }),
  });
  const { pick } = (await t.call('pick', { x: 1, y: 1 })) as { pick: { pickId: string } };
  t.f.tabs.annotate('tab-a', false);
  await t.call('ended');
  expect(t.f.tabs.annotate('tab-a', true)).toBe(true);
  const overlay = t.f.views[2]?.webContents as FakeContents;
  overlay.mainFrame.url = OVERLAY_URL;
  overlay.emit('did-finish-load');
  const call = (name: string, ...args: unknown[]) =>
    t.f.tabs.fromOverlay(overlay as never, overlay.mainFrame as never, name, args);
  const first = (await call('frame', { pointer: null, track: [pick.pickId] })) as {
    boxes: Record<string, unknown>;
  };
  expect(first.boxes[pick.pickId]).not.toBeNull();
  t.page.commit('https://example.com/next');
  const second = (await call('frame', { pointer: null, track: [pick.pickId] })) as {
    boxes: Record<string, unknown>;
  };
  expect(second.boxes[pick.pickId]).toBeNull();
  // The old overlay's calls go nowhere.
  await expect(t.call('end')).rejects.toThrow('Untrusted');
});

it("the app page's context reaches the overlay, now and when the next overlay loads; messages go back", async () => {
  const { f, overlay, call, told, app } = await annotated();
  f.tabs.annotateContext('tab-a', { locale: 'ko', collect: false });
  expect(told().at(-1)).toEqual({ type: 'context', context: { locale: 'ko', collect: false } });
  await call('tell', { collect: true });
  expect(app('annotate-message')).toEqual([
    { type: 'annotate-message', tabId: 'tab-a', message: { collect: true } },
  ]);
  await expect(call('tell', { big: 'x'.repeat(17 * 1024) })).rejects.toThrow();
  f.tabs.place('tab-a', null);
  f.tabs.place('tab-a', { x: 10, y: 50, width: 800, height: 600 });
  f.tabs.annotate('tab-a', true);
  const next = f.views[2]?.webContents as FakeContents;
  next.emit('did-finish-load');
  const events = next.send.mock.calls.map((entry) => entry[1]);
  expect(events).toContainEqual({ type: 'context', context: { locale: 'ko', collect: false } });
  void overlay;
});

it('the focus the host gives back to the page area goes to the overlay while the mode is on', async () => {
  const { f, page, overlay, told } = await annotated();
  overlay.focus.mockClear();
  page.focus.mockClear();
  f.tabs.focus('tab-a');
  expect(overlay.focus).toHaveBeenCalledTimes(1);
  expect(page.focus).not.toHaveBeenCalled();
  expect(told().at(-1)).toEqual({ type: 'focus' });
});

it('turned on while the still stands in: the overlay takes the focus once the view shows again', async () => {
  const f = setup();
  f.tabs.navigate('tab-a', 'project_a', 'https://example.com/');
  const page = f.views[0]?.webContents as FakeContents;
  page.commit('https://example.com/');
  f.tabs.place('tab-a', { x: 0, y: 0, width: 400, height: 300 });
  const still = await f.tabs.still('tab-a');
  f.tabs.freeze('tab-a', still?.stillId as string);
  expect(f.tabs.annotate('tab-a', true)).toBe(true);
  const overlay = f.views[1]?.webContents as FakeContents;
  overlay.emit('did-finish-load');
  expect(overlay.focus).not.toHaveBeenCalled();
  f.tabs.thaw('tab-a');
  expect(overlay.focus).toHaveBeenCalledTimes(1);
  f.tabs.place('tab-a', { x: 0, y: 0, width: 500, height: 300 });
  expect(overlay.focus).toHaveBeenCalledTimes(1); // owed once
});

it('the mode ending at once with the keyboard in the overlay leaves the tab unfocused', async () => {
  const { f, overlay } = await annotated();
  overlay.emit('focus');
  f.tabs.place('tab-a', null);
  f.tabs.place('tab-a', { x: 10, y: 50, width: 800, height: 600 });
  expect(f.last('tab-a')?.pageFocused ?? false).toBe(false);
  expect(
    (f.tabs as unknown as { tabs: Map<string, { focused: boolean }> }).tabs.get('tab-a')?.focused,
  ).toBe(false);
});

it('overlapping previews of one property: the newer value shows and the older call is ok, not a page change', async () => {
  const answers: ((value: unknown) => void)[] = [];
  const { page, call } = await annotated({
    rule: () =>
      new Promise((done) => {
        answers.push(done);
      }),
  });
  const { pick } = (await call('pick', { x: 1, y: 1 })) as { pick: { pickId: string } };
  const older = call('preview', pick.pickId, 'color', 'rgb(1, 1, 1)');
  await flush();
  const newer = call('preview', pick.pickId, 'color', 'rgb(2, 2, 2)');
  await flush();
  answers.shift()?.({ selector: ':root > :nth-child(2)' });
  expect(await older).toEqual({ ok: true });
  await flush();
  answers.shift()?.({ selector: ':root > :nth-child(2)' });
  expect(await newer).toEqual({ ok: true });
  await flush();
  expect([...page.css.values()]).toEqual([
    ':root > :nth-child(2):not(#\\#c1):not(#\\#c2):not(#\\#c3) { color: rgb(2, 2, 2) !important; }',
  ]);
});

it('at the send a preview that the page moved onto another element is put back on the pick before the shot', async () => {
  const { page, call, app } = await annotated({
    rule: () => ({ selector: ':root > :nth-child(2) > :nth-child(1)' }),
    // The page put a sibling before it: its position is the second child now.
    shot: () => ({
      bounds: element.bounds,
      safe: true,
      selector: ':root > :nth-child(2) > :nth-child(2)',
    }),
  });
  const { pick } = (await call('pick', { x: 1, y: 1 })) as { pick: { pickId: string } };
  await call('preview', pick.pickId, 'font-size', '18px');
  await flush();
  void call('submit', note(pick.pickId));
  for (let i = 0; i < 4; i++) await flush();
  expect([...page.css.values()]).toEqual([
    ':root > :nth-child(2) > :nth-child(2):not(#\\#c1):not(#\\#c2):not(#\\#c3) { font-size: 18px !important; }',
  ]);
  const order = page.insertCSS.mock.invocationCallOrder.at(-1) as number;
  expect(order).toBeLessThan(page.capturePage.mock.invocationCallOrder.at(-1) as number);
  expect(app('annotate-submit')).toHaveLength(1);
});
