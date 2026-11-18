import { afterEach, expect, it, vi } from 'vitest';
import { BrowserTabs, type BrowserTabsPorts } from '../src/browser-tabs.ts';
import { type FakeContents, type FakeSession, memoryFiles, setup } from './browser-fakes.ts';

afterEach(() => {
  vi.useRealTimers();
});

const view = (f: ReturnType<typeof setup>, index: number) => {
  const found = f.views[index];
  if (!found) throw new Error(`no view ${index}`);
  return found;
};

it('one view per tab, in its project partition, with no preload and nothing exposed', () => {
  const f = setup();
  expect(f.tabs.navigate('tab-a', 'project_a', 'example.com/docs?token=abc')).toEqual({ ok: true });
  expect(f.tabs.navigate('tab-b', 'project_a', 'https://example.com/')).toEqual({ ok: true });
  expect(f.tabs.navigate('tab-c', 'project_b', 'https://example.com/')).toEqual({ ok: true });
  expect(f.views).toHaveLength(3);
  const [a, b, c] = [view(f, 0), view(f, 1), view(f, 2)];
  expect(a.webContents.loadURL).toHaveBeenCalledWith('https://example.com/docs?token=abc');
  const sa = f.sessionOf(a),
    sb = f.sessionOf(b),
    sc = f.sessionOf(c);
  expect(sa).toBe(sb);
  expect(sa).not.toBe(sc);
  for (const fake of [sa, sc]) {
    expect(fake.name).toMatch(/^persist:corral-browser-[0-9a-f]{32}$/);
    expect(fake.name).not.toContain('project');
    expect(fake.name).not.toBe('persist:corral');
  }
  const prefs = (a.init as { webPreferences: Record<string, unknown> }).webPreferences;
  expect(prefs).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
  expect(prefs.preload).toBeUndefined();
  // The same tab reuses its view; a second address does not make a second page.
  f.tabs.navigate('tab-a', 'project_a', 'https://example.org/');
  expect(f.views).toHaveLength(3);
  // A tab belongs to one project and one kind.
  expect(() => f.tabs.navigate('tab-a', 'project_b', 'https://example.org/')).toThrow();
});

it('an address that is not http(s) opens nothing and makes no view', () => {
  const f = setup();
  expect(f.tabs.navigate('tab-a', 'project_a', 'file:///etc/hosts')).toEqual({
    ok: false,
    reason: 'unsupported-address',
  });
  expect(f.views).toHaveLength(0);
  expect(f.events).toHaveLength(0);
});

it('the view shows only while placed and live; failures, closing and hiding hide it', () => {
  const f = setup();
  f.tabs.navigate('tab-a', 'project_a', 'https://example.com/');
  const v = view(f, 0);
  expect(f.children.has(v)).toBe(true);
  expect(v.visible).toBe(false);
  f.tabs.place('tab-a', { x: 10, y: 20.4, width: 400, height: 300 });
  expect(v.bounds).toEqual({ x: 13, y: 26, width: 500, height: 375 });
  expect(v.visible).toBe(true);
  v.webContents.fail('https://example.com/', -105);
  expect(v.visible).toBe(false);
  expect(f.last('tab-a')).toMatchObject({
    page: 'failed',
    failure: { kind: 'name-not-resolved', code: -105, certificate: null },
  });
  v.webContents.commit('https://example.com/', 'Example');
  expect(v.visible).toBe(true);
  expect(f.last('tab-a')).toMatchObject({ page: 'live', failure: null, title: 'Example' });
  // A cancelled load is not a failure.
  v.webContents.emit('did-fail-load', {}, -3, 'aborted', 'https://example.com/x', true, 1, 1);
  expect(f.last('tab-a')).toMatchObject({ page: 'live' });
  f.tabs.place('tab-a', null);
  expect(v.visible).toBe(false);
});

it('the person closing a tab unloads its page without asking; leaving only unloads', () => {
  const f = setup();
  f.tabs.navigate('tab-a', 'project_a', 'https://example.com/');
  f.tabs.navigate('tab-b', 'project_a', 'https://example.com/');
  const [a, b] = [view(f, 0), view(f, 1)];
  f.tabs.close('tab-a');
  expect(a.webContents.close).toHaveBeenCalledWith();
  expect(f.children.has(a)).toBe(false);
  // Our own unload is not "the page closed itself".
  expect(f.states('tab-a').some((state) => state.page === 'closed-itself')).toBe(false);
  f.tabs.unload('tab-b');
  expect(b.webContents.isDestroyed()).toBe(true);
  expect(f.last('tab-b')).toMatchObject({ page: 'none' });
  // Coming back reloads the remembered address in a new view of the same storage.
  f.tabs.navigate('tab-b', 'project_a', 'https://example.com/docs');
  expect(f.views).toHaveLength(3);
  expect(f.sessionOf(view(f, 2))).toBe(f.sessionOf(b));
});

it('a person-opened tab whose page closes itself stays, and reopens its last address', async () => {
  const f = setup();
  f.tabs.navigate('tab-a', 'project_a', 'https://app.example/a');
  const a = view(f, 0);
  f.tabs.place('tab-a', { x: 0, y: 0, width: 100, height: 100 });
  a.webContents.commit('https://app.example/a', 'App');
  a.webContents.emit('focus');
  a.webContents.destroy();
  expect(f.events.some((event) => event.type === 'popup-closed')).toBe(false);
  expect(f.last('tab-a')).toMatchObject({
    page: 'closed-itself',
    url: 'https://app.example/a',
    title: 'App',
    pageFocused: true,
    canGoBack: false,
  });
  expect(f.children.has(a)).toBe(false);
  await f.tabs.reopen('tab-a');
  const again = view(f, 1);
  expect(again.webContents.loadURL).toHaveBeenCalledWith('https://app.example/a');
  expect(f.sessionOf(again)).toBe(f.sessionOf(a));
  expect(f.last('tab-a')).toMatchObject({ page: 'live' });
  expect(again.visible).toBe(true);
});

it('a page opens one new tab per fresh input, kept past its opener; none without input', () => {
  const f = setup();
  f.tabs.navigate('tab-a', 'project_a', 'https://app.example/');
  const opener = view(f, 0).webContents;
  expect(opener.open('https://login.example/')).toEqual({ action: 'deny' });
  opener.emit('input-event', {}, { type: 'mouseDown' });
  f.advance(1000);
  const allowed = opener.open('https://login.example/') as {
    action: string;
    outlivesOpener: boolean;
    createWindow: (options: { webContents: FakeContents }) => unknown;
    overrideBrowserWindowOptions: { webPreferences: Record<string, unknown> };
  };
  expect(allowed).toMatchObject({ action: 'allow', outlivesOpener: true });
  expect(allowed.overrideBrowserWindowOptions.webPreferences).toMatchObject({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  });
  // One input, one window.
  expect(opener.open('https://second.example/')).toEqual({ action: 'deny' });
  const made = new (view(f, 0).webContents.constructor as new () => FakeContents)();
  expect(allowed.createWindow({ webContents: made })).toBe(made);
  const popupEvent = f.events.find((event) => event.type === 'popup');
  expect(popupEvent).toEqual({
    type: 'popup',
    tabId: 'id1',
    openerTabId: 'tab-a',
    projectId: 'project_a',
  });
  expect(view(f, 1).webContents).toBe(made);
  expect(view(f, 1).visible).toBe(false);
  // Five seconds after an input is too late.
  opener.emit('input-event', {}, { type: 'keyDown' });
  f.advance(5001);
  expect(opener.open('https://late.example/')).toEqual({ action: 'deny' });
  // A non-web address never opens a window.
  opener.emit('input-event', {}, { type: 'mouseDown' });
  expect(opener.open('javascript:alert(1)')).toEqual({ action: 'deny' });
  // The opener's tab closing leaves the pop-up tab and its page.
  f.tabs.close('tab-a');
  expect(made.isDestroyed()).toBe(false);
  expect(f.events.some((event) => event.type === 'popup-closed')).toBe(false);
});

it("a pop-up tab is removed when its page closes; after an unload it is a person's tab", async () => {
  const f = setup();
  f.tabs.navigate('tab-a', 'project_a', 'https://app.example/');
  const opener = view(f, 0).webContents;
  const Contents = opener.constructor as new () => FakeContents;
  const popup = (contents: FakeContents) => {
    opener.emit('input-event', {}, { type: 'mouseDown' });
    const answer = opener.open('https://login.example/') as {
      createWindow: (options: { webContents: FakeContents }) => unknown;
    };
    answer.createWindow({ webContents: contents });
  };
  const first = new Contents();
  popup(first);
  first.destroy();
  expect(f.events).toContainEqual({ type: 'popup-closed', tabId: 'id1' });
  await expect(f.tabs.reopen('id1')).rejects.toThrow();
  const second = new Contents();
  popup(second);
  f.tabs.unload('id2');
  f.tabs.navigate('id2', 'project_a', 'https://login.example/');
  const reloaded = view(f, f.views.length - 1).webContents;
  expect(reloaded).not.toBe(second);
  reloaded.destroy();
  expect(f.events.filter((event) => event.type === 'popup-closed')).toHaveLength(1);
  expect(f.last('id2')).toMatchObject({ page: 'closed-itself' });
});

it('keys: Shift+Escape and app shortcuts go to the host, Mod+R and zoom act on the page', () => {
  const f = setup();
  f.tabs.navigate('tab-a', 'project_a', 'https://docs.example/a');
  const page = view(f, 0).webContents;
  const leave = page.key({ key: 'Escape', code: 'Escape', shift: true });
  expect(leave.preventDefault).toHaveBeenCalled();
  expect(f.ports.focusHost).toHaveBeenCalledTimes(1);
  expect(f.events).toContainEqual({ type: 'leave', tabId: 'tab-a' });
  const up = page.key({ type: 'keyUp', key: 'Escape', code: 'Escape', shift: true });
  expect(up.preventDefault).toHaveBeenCalled();
  expect(f.events.filter((event) => event.type === 'leave')).toHaveLength(1);
  page.key({ key: 'k', code: 'KeyK', control: true });
  expect(f.events).toContainEqual({ type: 'shortcut', tabId: 'tab-a', id: 'palette' });
  page.key({ key: '2', code: 'Digit2', control: true });
  expect(f.events).toContainEqual({
    type: 'shortcut',
    tabId: 'tab-a',
    id: 'session.jump',
    digit: 2,
  });
  const reload = page.key({ key: 'r', code: 'KeyR', control: true });
  expect(reload.preventDefault).toHaveBeenCalled();
  expect(page.reload).toHaveBeenCalledTimes(1);
  page.key({ key: '=', code: 'Equal', control: true });
  expect(page.zoom).toBe(0.5);
  page.key({ key: '0', code: 'Digit0', control: true });
  expect(page.zoom).toBe(0);
  const typing = page.key({ key: 'a', code: 'KeyA' });
  expect(typing.preventDefault).not.toHaveBeenCalled();
  const composing = page.key({ key: 'Escape', shift: true, isComposing: true });
  expect(composing.preventDefault).not.toHaveBeenCalled();
  // The host's rebinding replaces the chords taken from pages.
  f.tabs.setShortcuts([{ id: 'palette', mod: true, key: 'p' }]);
  expect(page.key({ key: 'k', code: 'KeyK', control: true }).preventDefault).not.toHaveBeenCalled();
  expect(page.key({ key: 'p', code: 'KeyP', control: true }).preventDefault).toHaveBeenCalled();
});

it('keys are taken from pop-up pages too', () => {
  const f = setup();
  f.tabs.navigate('tab-a', 'project_a', 'https://app.example/');
  const opener = view(f, 0).webContents;
  opener.emit('input-event', {}, { type: 'mouseDown' });
  const answer = opener.open('https://login.example/') as {
    createWindow: (options: { webContents: FakeContents }) => unknown;
  };
  const made = new (opener.constructor as new () => FakeContents)();
  answer.createWindow({ webContents: made });
  expect(made.key({ key: 'Escape', shift: true }).preventDefault).toHaveBeenCalled();
  expect(f.events).toContainEqual({ type: 'leave', tabId: 'id1' });
});

it('the still-image swap: picture first, hide after it is painted, a newer step wins', async () => {
  const f = setup();
  f.tabs.navigate('tab-a', 'project_a', 'https://example.com/');
  const v = view(f, 0);
  expect(await f.tabs.still('tab-a')).toBeNull(); // not placed: nothing on screen to picture
  f.tabs.place('tab-a', { x: 0, y: 0, width: 400, height: 300 });
  const still = await f.tabs.still('tab-a');
  expect(still).toEqual({
    stillId: 'id1',
    dataUrl: 'data:image/png;base64,still',
    width: 400,
    height: 300,
  });
  expect(v.visible).toBe(true);
  expect(f.tabs.freeze('tab-a', 'id1')).toBe(true);
  expect(v.visible).toBe(false);
  f.tabs.thaw('tab-a');
  expect(v.visible).toBe(true);
  // The host thaws before an earlier capture's freeze arrives: the view stays live.
  let finish!: (image: unknown) => void;
  v.webContents.capturePage.mockImplementationOnce(
    () =>
      new Promise((done) => {
        finish = done;
      }) as never,
  );
  const pending = f.tabs.still('tab-a');
  f.tabs.thaw('tab-a');
  finish({ toDataURL: () => 'data:,', getSize: () => ({ width: 1, height: 1 }) });
  const late = await pending;
  expect(late).toBeNull();
  expect(f.tabs.freeze('tab-a', 'id1')).toBe(false);
  expect(v.visible).toBe(true);
  // A frozen tab stays hidden when placed again, until thawed.
  const next = await f.tabs.still('tab-a');
  f.tabs.freeze('tab-a', next?.stillId ?? '');
  f.tabs.place('tab-a', { x: 5, y: 5, width: 300, height: 300 });
  expect(v.visible).toBe(false);
});

it('fullscreen is refused and the page stays in the tab', () => {
  const f = setup();
  f.tabs.navigate('tab-a', 'project_a', 'https://video.example/');
  const page = view(f, 0).webContents;
  const session = f.sessionOf(view(f, 0));
  expect(session.request(page, 'fullscreen').answer).toBe(false);
  expect(f.events.some((event) => event.type === 'permission')).toBe(false);
});

it('a preview tab gets its own in-memory storage under the lease rules, cleared on close', async () => {
  const f = setup();
  await f.tabs.openPreview('tab-p', 'session_1', 'lease_1');
  await f.tabs.openPreview('tab-q', 'session_1', 'lease_1');
  const [p, q] = [view(f, 0), view(f, 1)];
  const sp = f.sessionOf(p),
    sq = f.sessionOf(q);
  expect(sp).not.toBe(sq);
  for (const fake of [sp, sq]) {
    expect(fake.name).not.toMatch(/^persist:/);
    expect(fake.webRequestHandlers).toEqual([
      'onBeforeRequest',
      'onBeforeSendHeaders',
      'onHeadersReceived',
    ]);
    expect(fake.request(p.webContents, 'notifications').answer).toBe(false);
  }
  expect(p.webContents.loadURL).toHaveBeenCalledWith(f.lease.url);
  p.webContents.commit('http://127.0.0.2:4321/key-path/page?q=1', 'Preview app');
  expect(f.last('tab-p')).toMatchObject({ kind: 'preview', url: 'http://127.0.0.2:4321/page' });
  expect(JSON.stringify(f.events)).not.toContain('key-path');
  expect(JSON.stringify(f.events)).not.toContain('lease-token');
  f.tabs.close('tab-p');
  expect(sp.clearStorageData).toHaveBeenCalled();
  await f.tabs.openPreview('tab-p', 'session_1', 'lease_1');
  expect(f.sessionOf(view(f, 2))).not.toBe(sp);
  // A preview tab has no ordinary address.
  expect(() => f.tabs.navigate('tab-q', 'project_a', 'https://example.com/')).toThrow();
});

it('a preview tab blocks moves off the lease and says so; same-lease windows stay silent', async () => {
  const f = setup();
  await f.tabs.openPreview('tab-p', 'session_1', 'lease_1');
  const page = view(f, 0).webContents;
  page.commit('http://127.0.0.2:4321/key-path/index.html');
  const link = { url: 'https://docs.example/', preventDefault: vi.fn() };
  page.emit('will-navigate', link, link.url);
  expect(link.preventDefault).toHaveBeenCalled();
  expect(f.last('tab-p')?.blocked).toEqual({ url: 'https://docs.example/' });
  expect(f.tabs.openBlocked('tab-p')).toBe(true);
  expect(f.ports.openExternal).toHaveBeenCalledWith('https://docs.example/');
  // A move inside the lease clears the line.
  page.emit('did-start-navigation', {
    url: 'http://127.0.0.2:4321/key-path/next.html',
    isMainFrame: true,
    isSameDocument: false,
  });
  expect(f.last('tab-p')?.blocked).toBeNull();
  // A redirect off the lease is stopped and named.
  const redirect = { url: 'https://cdn.example/a', isMainFrame: true, preventDefault: vi.fn() };
  page.emit('will-redirect', redirect, redirect.url);
  expect(redirect.preventDefault).toHaveBeenCalled();
  expect(f.last('tab-p')?.blocked).toEqual({ url: 'https://cdn.example/a' });
  // New windows never open, even with an input; off-lease ones replace the line.
  page.emit('input-event', {}, { type: 'mouseDown' });
  expect(page.open('https://other.example/')).toEqual({ action: 'deny' });
  expect(f.last('tab-p')?.blocked).toEqual({ url: 'https://other.example/' });
  const before = f.events.length;
  expect(page.open('http://127.0.0.2:4321/key-path/same.html')).toEqual({ action: 'deny' });
  expect(f.events.length).toBe(before);
  expect(f.views).toHaveLength(1);
  // A non-web address has no system-browser action.
  const odd = { url: 'mailto:someone@example.com', preventDefault: vi.fn() };
  page.emit('will-navigate', odd, odd.url);
  expect(f.last('tab-p')?.blocked).toEqual({ url: null });
  expect(f.tabs.openBlocked('tab-p')).toBe(false);
  // The ordinary page has no such rule.
  f.tabs.navigate('tab-a', 'project_a', 'https://example.com/');
  const ordinary = view(f, 1).webContents;
  const away = { url: 'https://docs.example/', preventDefault: vi.fn() };
  ordinary.emit('will-navigate', away, away.url);
  expect(away.preventDefault).not.toHaveBeenCalled();
});

it('a preview whose lease ends shows the end, unloads, clears its storage and stays', async () => {
  const f = setup();
  await f.tabs.openPreview('tab-p', 'session_1', 'lease_1');
  const p = view(f, 0);
  const storage = f.sessionOf(p);
  f.ports.resolveLease.mockRejectedValueOnce(new Error('gone'));
  await f.tick();
  expect(f.last('tab-p')).toMatchObject({ page: 'ended' });
  expect(p.webContents.isDestroyed()).toBe(true);
  expect(storage.clearStorageData).toHaveBeenCalled();
  expect(f.events.some((event) => event.type === 'popup-closed')).toBe(false);
  // Mod+R in a preview checks the lease first.
  await f.tabs.openPreview('tab-r', 'session_1', 'lease_1');
  const r = view(f, 1).webContents;
  f.ports.resolveLease.mockResolvedValueOnce({ ...f.lease, headers: { 'x-corral-preview': 'n' } });
  r.key({ key: 'r', code: 'KeyR', control: true });
  await vi.waitFor(() => expect(f.last('tab-r')).toMatchObject({ page: 'ended' }));
  expect(r.reload).not.toHaveBeenCalled();
});

it('a preview tab closed while its lease is being resolved does not open', async () => {
  const f = setup();
  let answer!: (value: unknown) => void;
  f.ports.resolveLease.mockImplementationOnce(
    () =>
      new Promise((done) => {
        answer = done as (value: unknown) => void;
      }),
  );
  const pending = f.tabs.openPreview('tab-p', 'session_1', 'lease_1');
  await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
  f.tabs.close('tab-p');
  answer(structuredClone(f.lease));
  await expect(pending).rejects.toThrow();
  expect(f.views).toHaveLength(0);
});

it('element capture works on a preview tab and refuses ordinary pages', async () => {
  const f = setup();
  await f.tabs.openPreview('tab-p', 'session_1', 'lease_1');
  const page = view(f, 0).webContents;
  page.commit('http://127.0.0.2:4321/key-path/index.html');
  page.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce({
    element: {
      tag: 'button',
      role: null,
      selector: 'button',
      text: 'Save',
      bounds: { x: 1, y: 1, width: 10, height: 10 },
      styles: {},
    },
    screenshotSafe: true,
  });
  const pending = f.tabs.capturePreview('tab-p', { screenshot: false, console: false });
  await vi.waitFor(() => expect(page.listenerCount('context-menu')).toBe(1));
  page.emit(
    'context-menu',
    { preventDefault: vi.fn() },
    { x: 2, y: 2, frame: page.mainFrame, menuSourceType: 'mouse' },
  );
  await expect(pending).resolves.toMatchObject({
    sessionId: 'session_1',
    leaseId: 'lease_1',
    url: 'http://127.0.0.2:4321/index.html',
    element: { text: 'Save' },
  });
  f.tabs.navigate('tab-a', 'project_a', 'https://example.com/');
  await expect(
    f.tabs.capturePreview('tab-a', { screenshot: false, console: false }),
  ).rejects.toThrow();
});

it('removing a project closes its tabs, clears its storage and deletes it at the next start', async () => {
  const { io, files } = memoryFiles();
  const f = setup({ files: io });
  f.tabs.navigate('tab-a', 'project_a', 'https://app.example/');
  f.tabs.navigate('tab-b', 'project_b', 'https://app.example/');
  const [a, b] = [view(f, 0), view(f, 1)];
  const storage = f.sessionOf(a) as FakeSession;
  storage.request(a.webContents, 'notifications');
  const ask = f.events.find((event) => event.type === 'permission');
  if (ask?.type !== 'permission') throw new Error('no ask');
  f.tabs.answerPermission('tab-a', ask.requestId, true);
  expect([...files.keys()]).toHaveLength(1);
  await f.tabs.removeProject('project_a');
  expect(a.webContents.isDestroyed()).toBe(true);
  expect(b.webContents.isDestroyed()).toBe(false);
  expect(storage.clearStorageData).toHaveBeenCalled();
  expect(storage.clearAuthCache).toHaveBeenCalled();
  expect([...files.keys()]).toEqual(['removed-partitions.json']);
  expect(f.ports.removePartition).not.toHaveBeenCalled();
  // The next start removes the partition's folder before anything opens it.
  const next = new BrowserTabs({ ...f.ports, files: io } as unknown as BrowserTabsPorts);
  expect(next).toBeDefined();
  expect(f.ports.removePartition).toHaveBeenCalledWith(storage.name);
  expect(files.has('removed-partitions.json')).toBe(false);
});
