import { expect, it, vi } from 'vitest';
import type { BrowserEvent } from '../src/browser-bridge.ts';
import { type FakeContents, FakeItem, type FakeSession, setup } from './browser-fakes.ts';

const view = (f: ReturnType<typeof setup>, index: number) => {
  const found = f.views[index];
  if (!found) throw new Error(`no view ${index}`);
  return found;
};
const asks = (events: BrowserEvent[]) =>
  events.flatMap((event) => (event.type === 'permission' ? [event] : []));

function page(f: ReturnType<typeof setup>, tabId: string, projectId: string, url: string) {
  f.tabs.navigate(tabId, projectId, url);
  const v = view(f, f.views.length - 1);
  v.webContents.commit(url);
  return { contents: v.webContents, session: f.sessionOf(v) as FakeSession };
}

it('a permission is asked once per site, remembered, and read back by the page', () => {
  const f = setup();
  const a = page(f, 'tab-a', 'project_a', 'https://news.example/');
  expect(a.session.checkHandler?.(a.contents, 'notifications', 'https://news.example', {})).toBe(
    false,
  );
  const first = a.session.request(a.contents, 'notifications');
  expect(first.answer).toBeUndefined();
  const [ask] = asks(f.events);
  expect(ask).toEqual({
    type: 'permission',
    tabId: 'tab-a',
    requestId: 'id1',
    origin: 'https://news.example',
    permissions: ['notifications'],
  });
  f.tabs.answerPermission('tab-a', 'id1', true);
  expect(first.answer).toBe(true);
  expect(f.events).toContainEqual({ type: 'permission-ended', tabId: 'tab-a', requestId: 'id1' });
  expect(a.session.checkHandler?.(a.contents, 'notifications', 'https://news.example', {})).toBe(
    true,
  );
  // After a reload, and in another tab of the project, it is not asked again.
  expect(a.session.request(a.contents, 'notifications').answer).toBe(true);
  const b = page(f, 'tab-b', 'project_a', 'https://news.example/other');
  expect(b.session.request(b.contents, 'notifications').answer).toBe(true);
  expect(asks(f.events)).toHaveLength(1);
  // Another project has its own answers.
  const c = page(f, 'tab-c', 'project_b', 'https://news.example/');
  expect(c.session.checkHandler?.(c.contents, 'notifications', 'https://news.example', {})).toBe(
    false,
  );
  // The site permissions menu shows and forgets them.
  expect(f.tabs.sitePermissions('project_a', 'https://news.example')).toEqual([
    { permission: 'notifications', allow: true },
  ]);
  f.tabs.forgetPermission('project_a', 'https://news.example', 'notifications');
  expect(a.session.request(a.contents, 'notifications').answer).toBeUndefined();
  expect(asks(f.events)).toHaveLength(2);
});

it('an ask the tab leaves or closes is refused and not remembered; asks are coalesced', () => {
  const f = setup();
  const a = page(f, 'tab-a', 'project_a', 'https://meet.example/');
  const one = a.session.request(a.contents, 'media', { mediaTypes: ['video', 'audio'] });
  const two = a.session.request(a.contents, 'media', { mediaTypes: ['video', 'audio'] });
  expect(asks(f.events)).toHaveLength(1);
  expect(asks(f.events)[0]?.permissions).toEqual(['camera', 'microphone']);
  a.contents.commit('https://meet.example/room');
  expect(one.answer).toBe(false);
  expect(two.answer).toBe(false);
  expect(f.events).toContainEqual({ type: 'permission-ended', tabId: 'tab-a', requestId: 'id1' });
  expect(f.tabs.sitePermissions('project_a', 'https://meet.example')).toEqual([]);
  // Answering a request that is over does nothing.
  f.tabs.answerPermission('tab-a', 'id1', true);
  expect(f.tabs.sitePermissions('project_a', 'https://meet.example')).toEqual([]);
  const three = a.session.request(a.contents, 'media', { mediaTypes: ['video'] });
  f.tabs.close('tab-a');
  expect(three.answer).toBe(false);
  expect(f.tabs.sitePermissions('project_a', 'https://meet.example')).toEqual([]);
});

it('a camera answer covers camera only; a remembered refusal is never asked again', () => {
  const f = setup();
  const a = page(f, 'tab-a', 'project_a', 'https://meet.example/');
  const camera = a.session.request(a.contents, 'media', { mediaTypes: ['video'] });
  f.tabs.answerPermission('tab-a', asks(f.events)[0]?.requestId ?? '', false);
  expect(camera.answer).toBe(false);
  expect(a.session.request(a.contents, 'media', { mediaTypes: ['video', 'audio'] }).answer).toBe(
    false,
  );
  const mic = a.session.request(a.contents, 'media', { mediaTypes: ['audio'] });
  expect(asks(f.events).at(-1)?.permissions).toEqual(['microphone']);
  f.tabs.answerPermission('tab-a', asks(f.events).at(-1)?.requestId ?? '', true);
  expect(mic.answer).toBe(true);
  expect(
    a.session.checkHandler?.(a.contents, 'media', 'https://meet.example', {
      mediaType: 'video',
    }),
  ).toBe(false);
  expect(
    a.session.checkHandler?.(a.contents, 'media', 'https://meet.example', {
      mediaType: 'audio',
    }),
  ).toBe(true);
});

it('a combined request asks only what is unanswered and goes through only when all is allowed', () => {
  const f = setup();
  const a = page(f, 'tab-a', 'project_a', 'https://meet.example/');
  const camera = a.session.request(a.contents, 'media', { mediaTypes: ['video'] });
  f.tabs.answerPermission('tab-a', asks(f.events).at(-1)?.requestId ?? '', true);
  expect(camera.answer).toBe(true);
  // Camera allowed earlier: the line names the microphone only.
  const both = a.session.request(a.contents, 'media', { mediaTypes: ['video', 'audio'] });
  expect(both.answer).toBeUndefined();
  expect(asks(f.events).at(-1)).toMatchObject({
    origin: 'https://meet.example',
    permissions: ['microphone'],
  });
  f.tabs.answerPermission('tab-a', asks(f.events).at(-1)?.requestId ?? '', true);
  expect(both.answer).toBe(true);
  expect(f.tabs.sitePermissions('project_a', 'https://meet.example')).toEqual([
    { permission: 'camera', allow: true },
    { permission: 'microphone', allow: true },
  ]);
  // Each is forgotten on its own; a refusal on the line refuses the whole request.
  f.tabs.forgetPermission('project_a', 'https://meet.example', 'microphone');
  expect(f.tabs.sitePermissions('project_a', 'https://meet.example')).toEqual([
    { permission: 'camera', allow: true },
  ]);
  const again = a.session.request(a.contents, 'media', { mediaTypes: ['video', 'audio'] });
  expect(asks(f.events).at(-1)?.permissions).toEqual(['microphone']);
  f.tabs.answerPermission('tab-a', asks(f.events).at(-1)?.requestId ?? '', false);
  expect(again.answer).toBe(false);
  expect(f.tabs.sitePermissions('project_a', 'https://meet.example')).toEqual([
    { permission: 'camera', allow: true },
    { permission: 'microphone', allow: false },
  ]);
  // One remembered refusal refuses the request without asking, though the camera is allowed.
  const count = asks(f.events).length;
  expect(a.session.request(a.contents, 'media', { mediaTypes: ['video', 'audio'] }).answer).toBe(
    false,
  );
  expect(asks(f.events)).toHaveLength(count);
  // Neither answered: one line names both, and its one answer is remembered for each.
  const b = page(f, 'tab-b', 'project_a', 'https://call.example/');
  const fresh = b.session.request(b.contents, 'media', { mediaTypes: ['video', 'audio'] });
  expect(asks(f.events).at(-1)?.permissions).toEqual(['camera', 'microphone']);
  f.tabs.answerPermission('tab-b', asks(f.events).at(-1)?.requestId ?? '', true);
  expect(fresh.answer).toBe(true);
  expect(f.tabs.sitePermissions('project_a', 'https://call.example')).toEqual([
    { permission: 'camera', allow: true },
    { permission: 'microphone', allow: true },
  ]);
});

it('device pickers are refused without asking', () => {
  const f = setup();
  const a = page(f, 'tab-a', 'project_a', 'https://iot.example/');
  for (const permission of ['hid', 'serial', 'usb'])
    expect(a.session.request(a.contents, permission).answer).toBe(false);
  expect(a.session.deviceHandler?.({ deviceType: 'hid', origin: 'https://iot.example' })).toBe(
    false,
  );
  for (const [name, args, cancel] of [
    ['select-hid-device', [{ deviceList: [{ deviceId: 'd' }] }], []],
    ['select-usb-device', [{ deviceList: [{ deviceId: 'd' }] }], []],
    ['select-serial-port', [[{ portId: 'p' }], a.contents], ['']],
  ] as const) {
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();
    a.session.emit(name, event, ...args, callback);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith(...cancel);
  }
  const event = { preventDefault: vi.fn() };
  const callback = vi.fn();
  a.contents.emit('select-bluetooth-device', event, [{ deviceId: 'b' }], callback);
  expect(event.preventDefault).toHaveBeenCalled();
  expect(callback).toHaveBeenCalledWith('');
  expect(asks(f.events)).toHaveLength(0);
});

function certificateError(
  contents: FakeContents,
  url: string,
  init: { fingerprint?: string; isMainFrame?: boolean; error?: string } = {},
) {
  const event = { preventDefault: vi.fn() };
  const callback = vi.fn();
  contents.emit(
    'certificate-error',
    event,
    url,
    init.error ?? 'net::ERR_CERT_AUTHORITY_INVALID',
    {
      fingerprint: init.fingerprint ?? 'sha256/one',
      issuerName: 'localhost',
      subjectName: 'localhost',
    },
    callback,
    init.isMainFrame ?? true,
  );
  return { event, callback };
}

it('a public certificate error has no way past and the default refusal stands', () => {
  const f = setup();
  f.tabs.navigate('tab-a', 'project_a', 'https://expired.example/');
  const contents = view(f, 0).webContents;
  contents.emit('did-start-navigation', {
    url: 'https://expired.example/',
    isMainFrame: true,
    isSameDocument: false,
  });
  const { event, callback } = certificateError(contents, 'https://expired.example/', {
    error: 'net::ERR_CERT_DATE_INVALID',
  });
  // Exactly one listener may answer; ours leaves the event alone.
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(callback).not.toHaveBeenCalled();
  contents.emit(
    'did-fail-load',
    {},
    -201,
    'ERR_CERT_DATE_INVALID',
    'https://expired.example/',
    true,
  );
  expect(f.last('tab-a')?.failure).toEqual({
    kind: 'certificate',
    code: -201,
    certificate: { reason: 'expired', challengeId: null },
  });
  expect(f.tabs.proceedCertificate('tab-a', 'anything')).toBe(false);
});

it('"Open anyway" trusts a loopback certificate per project, host and certificate, in memory', () => {
  const f = setup();
  f.tabs.navigate('tab-a', 'project_a', 'https://localhost:8443/');
  const a = view(f, 0).webContents;
  const first = certificateError(a, 'https://localhost:8443/');
  expect(first.event.preventDefault).not.toHaveBeenCalled();
  a.emit('did-fail-load', {}, -202, 'ERR_CERT_AUTHORITY_INVALID', 'https://localhost:8443/', true);
  const challenge = f.last('tab-a')?.failure?.certificate;
  expect(challenge).toEqual({ reason: 'self-signed', challengeId: 'id1' });
  expect(f.tabs.proceedCertificate('tab-a', 'wrong')).toBe(false);
  expect(f.tabs.proceedCertificate('tab-a', 'id1')).toBe(true);
  expect(a.loadURL).toHaveBeenLastCalledWith('https://localhost:8443/');
  // The retry and any later error with the same certificate are answered at once.
  const retry = certificateError(a, 'https://localhost:8443/');
  expect(retry.event.preventDefault).toHaveBeenCalled();
  expect(retry.callback).toHaveBeenCalledWith(true);
  f.tabs.navigate('tab-b', 'project_a', 'https://localhost:8443/');
  const b = view(f, 1).webContents;
  expect(certificateError(b, 'https://localhost:8443/').callback).toHaveBeenCalledWith(true);
  // Another certificate, another loopback host, another project: asked again.
  expect(
    certificateError(b, 'https://localhost:8443/', { fingerprint: 'sha256/two' }).callback,
  ).not.toHaveBeenCalled();
  expect(certificateError(b, 'https://127.0.0.1:8443/').callback).not.toHaveBeenCalled();
  f.tabs.navigate('tab-c', 'project_b', 'https://localhost:8443/');
  const c = view(f, 2).webContents;
  expect(certificateError(c, 'https://localhost:8443/').callback).not.toHaveBeenCalled();
  // A subresource's error is never offered or trusted.
  const image = certificateError(a, 'https://localhost:9443/img.png', { isMainFrame: false });
  expect(image.callback).not.toHaveBeenCalled();
  // The lease host and other local names are not loopback.
  f.tabs.navigate('tab-d', 'project_a', 'https://127.0.0.2:8443/');
  const d = view(f, 3).webContents;
  certificateError(d, 'https://127.0.0.2:8443/');
  d.emit('did-fail-load', {}, -202, 'ERR_CERT_AUTHORITY_INVALID', 'https://127.0.0.2:8443/', true);
  expect(f.last('tab-d')?.failure?.certificate?.challengeId).toBeNull();
});

it('a challenge is dropped when the tab moves on', () => {
  const f = setup();
  f.tabs.navigate('tab-a', 'project_a', 'https://localhost:8443/');
  const a = view(f, 0).webContents;
  certificateError(a, 'https://localhost:8443/');
  a.emit('did-fail-load', {}, -202, 'ERR_CERT_AUTHORITY_INVALID', 'https://localhost:8443/', true);
  const id = f.last('tab-a')?.failure?.certificate?.challengeId ?? '';
  a.commit('https://localhost:8000/');
  expect(f.tabs.proceedCertificate('tab-a', id)).toBe(false);
});

function login(contents: FakeContents, url: string, isProxy = false) {
  const event = { preventDefault: vi.fn() };
  const callback = vi.fn();
  contents.emit(
    'login',
    event,
    { url, pid: 1 },
    { isProxy, scheme: 'basic', host: 'auth.example', port: 443, realm: 'r' },
    callback,
  );
  return { event, callback };
}

it('HTTP sign-in asks the host, passes the answer through and keeps nothing', () => {
  const f = setup();
  const a = page(f, 'tab-a', 'project_a', 'https://auth.example/');
  const { event, callback } = login(a.contents, 'https://auth.example/private?x=1');
  expect(event.preventDefault).toHaveBeenCalled();
  expect(f.events).toContainEqual({
    type: 'login',
    tabId: 'tab-a',
    requestId: 'id1',
    origin: 'https://auth.example',
  });
  f.tabs.answerLogin('tab-a', 'id1', { username: 'person', password: 'secret-pass' });
  expect(callback).toHaveBeenCalledWith('person', 'secret-pass');
  expect(JSON.stringify(f.events)).not.toContain('secret-pass');
  expect(f.events).toContainEqual({ type: 'login-ended', tabId: 'tab-a', requestId: 'id1' });
  // A second answer to the same request does nothing.
  f.tabs.answerLogin('tab-a', 'id1', { username: 'x', password: 'y' });
  expect(callback).toHaveBeenCalledTimes(1);
  // Cancel gives the site's 401: the callback without credentials.
  const cancelled = login(a.contents, 'https://auth.example/');
  f.tabs.answerLogin('tab-a', 'id2', null);
  expect(cancelled.callback).toHaveBeenCalledWith();
  // A pending sign-in never hangs: closing or leaving the page cancels it.
  const pending = login(a.contents, 'https://auth.example/');
  f.tabs.close('tab-a');
  expect(pending.callback).toHaveBeenCalledWith();
  expect(f.events).toContainEqual({ type: 'login-ended', tabId: 'tab-a', requestId: 'id3' });
});

it('a proxy sign-in is cancelled without asking', () => {
  const f = setup();
  const a = page(f, 'tab-a', 'project_a', 'https://auth.example/');
  const { callback } = login(a.contents, 'https://auth.example/', true);
  expect(callback).toHaveBeenCalledWith();
  expect(f.events.some((event) => event.type === 'login')).toBe(false);
});

const downloads = (events: BrowserEvent[]) =>
  events.flatMap((event) => (event.type === 'download' ? [event.download] : []));

function download(session: FakeSession, contents: FakeContents, name = 'report.pdf') {
  const item = new FakeItem(name);
  const event = { preventDefault: vi.fn() };
  session.emit('will-download', event, item, contents);
  return { item, event };
}

it('a download asks with a titled system dialog and shows progress once a place is chosen', () => {
  const f = setup();
  const a = page(f, 'tab-a', 'project_a', 'https://files.example/');
  const { item, event } = download(a.session, a.contents);
  expect(event.preventDefault).not.toHaveBeenCalled();
  expect(item.dialogOptions).toEqual({ title: '다운로드 저장' });
  item.progress(100); // the dialog is still open
  expect(downloads(f.events)).toHaveLength(0);
  item.savePath = '/home/person/Downloads/report (1).pdf';
  item.progress(200);
  expect(downloads(f.events).at(-1)).toEqual({
    downloadId: 'id1',
    tabId: 'tab-a',
    name: 'report (1).pdf',
    state: 'progressing',
    receivedBytes: 200,
    totalBytes: 1000,
  });
  item.finish();
  expect(downloads(f.events).at(-1)).toMatchObject({ state: 'completed', receivedBytes: 1000 });
  f.tabs.showDownload('id1');
  expect(f.ports.showItemInFolder).toHaveBeenCalledWith('/home/person/Downloads/report (1).pdf');
  expect(f.tabs.downloads('tab-a')).toHaveLength(1);
});

it('cancelling the save dialog leaves no line; closing the tab cancels its download', () => {
  const f = setup();
  const a = page(f, 'tab-a', 'project_a', 'https://files.example/');
  const cancelled = download(a.session, a.contents);
  cancelled.item.cancel();
  expect(downloads(f.events)).toHaveLength(0);
  // The dialog open while the tab closes: cancelled, and a late choice shows nothing.
  const open = download(a.session, a.contents);
  f.tabs.close('tab-a');
  expect(open.item.cancel).toHaveBeenCalled();
  open.item.savePath = '/tmp/late.bin';
  open.item.emit('updated', {}, 'progressing');
  expect(downloads(f.events)).toHaveLength(0);
});

it('leaving the conversation keeps a download going and its line comes back', () => {
  const f = setup();
  const a = page(f, 'tab-a', 'project_a', 'https://files.example/');
  const { item } = download(a.session, a.contents);
  item.savePath = '/home/person/Downloads/big.iso';
  item.progress(10);
  f.tabs.unload('tab-a');
  expect(item.cancel).not.toHaveBeenCalled();
  item.progress(20);
  expect(f.tabs.downloads('tab-a')).toEqual([
    expect.objectContaining({ tabId: 'tab-a', receivedBytes: 20, state: 'progressing' }),
  ]);
  f.tabs.close('tab-a');
  expect(item.cancel).toHaveBeenCalled();
});

it("a pop-up's download moves to its opener's tab and survives both tabs", () => {
  const f = setup();
  const a = page(f, 'tab-a', 'project_a', 'https://app.example/');
  a.contents.emit('input-event', {}, { type: 'mouseDown' });
  const answer = a.contents.open('https://files.example/get') as {
    createWindow: (options: { webContents: FakeContents }) => unknown;
  };
  const popup = new (a.contents.constructor as new () => FakeContents)();
  answer.createWindow({ webContents: popup });
  const { item } = download(a.session, popup);
  popup.destroy(); // the pop-up closes itself after starting the download
  expect(f.events).toContainEqual({ type: 'popup-closed', tabId: 'id1' });
  item.savePath = '/home/person/Downloads/file.zip';
  item.progress(50);
  expect(downloads(f.events).at(-1)).toMatchObject({ tabId: 'tab-a', state: 'progressing' });
  f.tabs.close('tab-a');
  expect(item.cancel).not.toHaveBeenCalled();
  item.progress(60);
  expect(downloads(f.events).at(-1)).toMatchObject({ tabId: null, receivedBytes: 60 });
  item.finish();
  expect(downloads(f.events).at(-1)).toMatchObject({ tabId: null, state: 'completed' });
});

it('a download from a page Corral does not know is refused; preview pages download nothing', async () => {
  const f = setup();
  const a = page(f, 'tab-a', 'project_a', 'https://files.example/');
  const stranger = new (a.contents.constructor as new () => FakeContents)();
  expect(download(a.session, stranger).event.preventDefault).toHaveBeenCalled();
  await f.tabs.openPreview('tab-p', 'session_1', 'lease_1');
  const p = view(f, 1);
  const lease = f.sessionOf(p) as FakeSession;
  expect(download(lease, p.webContents).event.preventDefault).toHaveBeenCalled();
});

it("clearing a project's data clears storage, cache, sign-ins and answers, then reloads its pages", async () => {
  const f = setup();
  const a = page(f, 'tab-a', 'project_a', 'https://news.example/');
  const b = page(f, 'tab-b', 'project_a', 'https://news.example/b');
  const c = page(f, 'tab-c', 'project_b', 'https://news.example/');
  await f.tabs.openPreview('tab-p', 'session_1', 'lease_1');
  const preview = view(f, 3).webContents;
  a.session.request(a.contents, 'notifications');
  f.tabs.answerPermission('tab-a', asks(f.events)[0]?.requestId ?? '', true);
  const pending = a.session.request(a.contents, 'geolocation');
  await f.tabs.clearProjectData('project_a');
  for (const clear of ['clearStorageData', 'clearCache', 'clearAuthCache'] as const)
    expect(a.session[clear]).toHaveBeenCalled();
  expect(c.session.clearStorageData).not.toHaveBeenCalled();
  expect(pending.answer).toBe(false);
  expect(f.tabs.sitePermissions('project_a', 'https://news.example')).toEqual([]);
  expect(a.contents.reload).toHaveBeenCalled();
  expect(b.contents.reload).toHaveBeenCalled();
  expect(c.contents.reload).not.toHaveBeenCalled();
  expect(preview.reload).not.toHaveBeenCalled();
});

it('the app page going away unloads every tab and keeps it; Corral quitting closes every tab', async () => {
  const f = setup();
  const a = page(f, 'tab-a', 'project_a', 'https://files.example/');
  const asked = a.session.request(a.contents, 'notifications');
  const signIn = login(a.contents, 'https://files.example/private');
  const { item } = download(a.session, a.contents);
  item.savePath = '/home/person/Downloads/big.iso';
  item.progress(10);
  await f.tabs.openPreview('tab-p', 'session_1', 'lease_1');
  const preview = view(f, f.views.length - 1);
  const storage = f.sessionOf(preview);
  let answer!: (value: unknown) => void;
  f.ports.resolveLease.mockImplementationOnce(
    () =>
      new Promise((done) => {
        answer = done as (value: unknown) => void;
      }),
  );
  const pending = f.tabs.openPreview('tab-q', 'session_1', 'lease_1');
  await vi.waitFor(() => expect(answer).toBeTypeOf('function'));

  f.tabs.unloadAll();
  // Nothing a page asked for is left hanging; downloads carry on.
  expect(asked.answer).toBe(false);
  expect(signIn.callback).toHaveBeenCalledWith();
  expect(f.events).toContainEqual({ type: 'permission-ended', tabId: 'tab-a', requestId: 'id1' });
  expect(f.events).toContainEqual({ type: 'login-ended', tabId: 'tab-a', requestId: 'id2' });
  expect(item.cancel).not.toHaveBeenCalled();
  expect(a.contents.isDestroyed()).toBe(true);
  expect(preview.webContents.isDestroyed()).toBe(true);
  expect(f.last('tab-a')).toMatchObject({ page: 'none', url: 'https://files.example/' });
  expect(f.last('tab-p')).toMatchObject({ page: 'none' });
  // A preview still being resolved when the page went does not open into the new page.
  answer(structuredClone(f.lease));
  await expect(pending).rejects.toThrow();
  const views = f.views.length;
  // The records stay: the download's line, the preview's storage and its kind.
  expect(f.tabs.downloads('tab-a')).toEqual([
    expect.objectContaining({ tabId: 'tab-a', state: 'progressing' }),
  ]);
  expect(storage.clearStorageData).not.toHaveBeenCalled();
  expect(() => f.tabs.navigate('tab-p', 'project_a', 'https://example.com/')).toThrow();
  expect(f.views).toHaveLength(views);

  await f.tabs.openPreview('tab-p', 'session_1', 'lease_1');
  expect(f.sessionOf(view(f, f.views.length - 1))).toBe(storage);
  f.tabs.closeAll();
  // Every tab goes with its preview storage; the download carries on without a line.
  expect(view(f, f.views.length - 1).webContents.isDestroyed()).toBe(true);
  expect(storage.clearStorageData).toHaveBeenCalled();
  expect(item.cancel).not.toHaveBeenCalled();
  expect(f.tabs.downloads('tab-a')).toEqual([]);
  item.progress(20);
  expect(downloads(f.events).at(-1)).toMatchObject({ tabId: null, receivedBytes: 20 });
  expect(() => f.tabs.navigate('tab-p', 'project_a', 'https://example.com/')).not.toThrow();
});
