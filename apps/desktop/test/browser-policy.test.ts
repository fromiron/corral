import { expect, it } from 'vitest';
import {
  APP_PAGE_SHORTCUTS,
  browserAddress,
  certificateReason,
  isLoopbackHost,
  loadFailure,
  NewWindowActivation,
  pageKey,
  pageMenu,
  pageShortcuts,
  permissionCheck,
  permissionRequest,
  refuseFullscreen,
  SITE_PERMISSIONS,
  systemBrowserUrl,
  zoomLevel,
} from '../src/browser-policy.ts';
import { studioDesktopBindings } from './studio-shortcuts.ts';

it('the address field opens only http(s), adds a scheme and drops credentials', () => {
  expect(browserAddress('example.com/docs?token=abc')).toBe('https://example.com/docs?token=abc');
  expect(browserAddress('  https://example.com  ')).toBe('https://example.com/');
  expect(browserAddress('localhost:5173')).toBe('http://localhost:5173/');
  expect(browserAddress('127.0.0.1:8080/a')).toBe('http://127.0.0.1:8080/a');
  expect(browserAddress('[::1]:3000')).toBe('http://[::1]:3000/');
  // A non-loopback local address is an ordinary page with https added, never a lease.
  expect(browserAddress('127.0.0.2:4000')).toBe('https://127.0.0.2:4000/');
  expect(browserAddress('http://example.com:8080/x#y')).toBe('http://example.com:8080/x#y');
  expect(browserAddress('https://user:pass@example.com/a')).toBe('https://example.com/a');
  for (const value of [
    '',
    '   ',
    'two words',
    'file:///etc/hosts',
    'javascript:alert(1)',
    'data:text/html,x',
    'mailto:someone@example.com',
    'about:blank',
    'ftp://example.com/',
    'chrome://settings',
    'https://',
    42,
    null,
    'x'.repeat(9000),
  ])
    expect(browserAddress(value)).toBeNull();
});

it('only localhost, 127.0.0.1 and ::1 count as loopback', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', '::1', 'LOCALHOST'])
    expect(isLoopbackHost(host)).toBe(true);
  for (const host of ['127.0.0.2', 'a.localhost', 'localhost.example', '0.0.0.0', 'example.com'])
    expect(isLoopbackHost(host)).toBe(false);
});

it('the system browser gets http(s) only, without credentials', () => {
  expect(systemBrowserUrl('https://user:pw@docs.example/a?b=c')).toBe('https://docs.example/a?b=c');
  for (const value of ['javascript:x', 'file:///a', 'mailto:a@b', 'not a url', undefined])
    expect(systemBrowserUrl(value)).toBeNull();
});

const key = (
  init: Partial<{
    type: string;
    key: string;
    code: string;
    shift: boolean;
    control: boolean;
    alt: boolean;
    meta: boolean;
    isComposing: boolean;
    isAutoRepeat: boolean;
  }>,
) => ({
  type: 'keyDown',
  key: '',
  code: '',
  shift: false,
  control: false,
  alt: false,
  meta: false,
  isComposing: false,
  isAutoRepeat: false,
  ...init,
});

it('Shift+Escape, Mod+R, the zoom keys and app shortcuts are taken from the page', () => {
  const chords = APP_PAGE_SHORTCUTS;
  expect(pageKey(key({ key: 'Escape', code: 'Escape', shift: true }), chords, false)).toEqual({
    action: 'leave',
  });
  expect(pageKey(key({ type: 'keyUp', key: 'Escape', shift: true }), chords, false)).toEqual({
    action: 'leave',
  });
  expect(pageKey(key({ key: 'r', code: 'KeyR', control: true }), chords, false)).toEqual({
    action: 'reload',
  });
  expect(pageKey(key({ key: 'R', code: 'KeyR', meta: true }), chords, true)).toEqual({
    action: 'reload',
  });
  for (const [input, zoom] of [
    [{ key: '=', code: 'Equal' }, 'in'],
    [{ key: '+', code: 'Equal', shift: true }, 'in'],
    [{ key: '+', code: 'NumpadAdd' }, 'in'],
    [{ key: '-', code: 'Minus' }, 'out'],
    [{ key: '0', code: 'Digit0' }, 'reset'],
  ] as const)
    expect(pageKey(key({ ...input, control: true }), chords, false)).toEqual({
      action: 'zoom',
      zoom,
    });
  expect(pageKey(key({ key: 'k', code: 'KeyK', control: true }), chords, false)).toEqual({
    action: 'shortcut',
    id: 'palette',
  });
  expect(pageKey(key({ key: 'j', code: 'KeyJ', control: true }), chords, false)).toEqual({
    action: 'shortcut',
    id: 'view.dock',
  });
  expect(pageKey(key({ key: '3', code: 'Digit3', control: true }), chords, false)).toEqual({
    action: 'shortcut',
    id: 'session.jump',
    digit: 3,
  });
  // Alt changes the key on a Mac keyboard; the physical key decides then.
  expect(pageKey(key({ key: '∫', code: 'KeyB', meta: true, alt: true }), chords, true)).toEqual({
    action: 'shortcut',
    id: 'view.panel',
  });
});

it('keys the page owns are left alone, and IME composition always is', () => {
  const chords = APP_PAGE_SHORTCUTS;
  for (const input of [
    key({ key: 'Escape', code: 'Escape' }),
    key({ key: 'k', code: 'KeyK' }),
    key({ key: 'c', code: 'KeyC', control: true }),
    key({ key: 'v', code: 'KeyV', control: true }),
    key({ key: 'R', code: 'KeyR', control: true, shift: true }),
    key({ key: 'r', code: 'KeyR', control: true, alt: true }),
    key({ key: '_', code: 'Minus', control: true, shift: true }),
    // The other platform's modifier is not Mod.
    key({ key: 'k', code: 'KeyK', meta: true }),
    key({ key: 'k', code: 'KeyK', control: true, meta: true }),
    // Alt-only chords stay with the page (reply.quote is Alt+Q in the registry).
    key({ key: 'q', code: 'KeyQ', alt: true }),
    key({ key: 'Escape', code: 'Escape', shift: true, isComposing: true }),
    key({ key: 'k', code: 'KeyK', control: true, isComposing: true }),
    key({ type: 'char', key: 'k', control: true }),
  ])
    expect(pageKey(input, chords, false)).toBeNull();
  expect(pageKey(key({ key: 'k', code: 'KeyK', control: true }), chords, true)).toBeNull();
});

it('a rebinding from the host replaces the app chords; Mod+R and zoom stay fixed', () => {
  const chords = pageShortcuts({
    palette: { mod: true, key: 'p' },
    'view.dock': { mod: true, shift: true, key: 'j' },
    'reload.hijack': { mod: true, key: 'r' },
    'reply.quote': { alt: true, key: 'q' },
  });
  expect(pageKey(key({ key: 'p', code: 'KeyP', control: true }), chords, false)).toEqual({
    action: 'shortcut',
    id: 'palette',
  });
  expect(pageKey(key({ key: 'k', code: 'KeyK', control: true }), chords, false)).toBeNull();
  expect(pageKey(key({ key: 'r', code: 'KeyR', control: true }), chords, false)).toEqual({
    action: 'reload',
  });
  // Alt-only chords stay with the page.
  expect(pageKey(key({ key: 'q', code: 'KeyQ', alt: true }), chords, false)).toBeNull();
  expect(pageShortcuts({})).toEqual([]);
  for (const value of [
    null,
    [],
    [{ id: 'palette', mod: true, key: 'k' }],
    { palette: { mod: true, key: 'Enter' } },
    { palette: { mod: true, key: 'k', extra: 1 } },
    { palette: { mod: 'yes', key: 'k' } },
    { palette: null },
    { 'bad id!': { mod: true, key: 'k' } },
    Object.fromEntries(Array.from({ length: 65 }, (_, n) => [`x${n}`, { mod: true, key: 'k' }])),
  ])
    expect(() => pageShortcuts(value)).toThrow();
});

it("the default app chords are the studio registry's Mod chords, and the whole registry is accepted", () => {
  // Every entry, as the studio's effectiveShortcuts() hands them over (Alt-only ones too).
  const bindings = studioDesktopBindings();
  expect(Object.keys(bindings).length).toBeGreaterThan(Object.keys(APP_PAGE_SHORTCUTS).length);
  expect(pageShortcuts(bindings)).toEqual(APP_PAGE_SHORTCUTS);
});

it('a new window needs a fresh input within 5 s, and one input opens one window', () => {
  let now = 1000;
  const gate = new NewWindowActivation(() => now);
  expect(gate.take()).toBe(false);
  gate.input('mouseMove');
  gate.input('mouseUp');
  gate.input('char');
  expect(gate.take()).toBe(false);
  gate.input('mouseDown');
  now += 1000;
  expect(gate.take()).toBe(true);
  expect(gate.take()).toBe(false);
  gate.input('rawKeyDown');
  now += 5001;
  expect(gate.take()).toBe(false);
  gate.input('keyDown');
  now += 5000;
  expect(gate.take()).toBe(true);
  // Two signals of one press do not stack into two windows.
  gate.input('rawKeyDown');
  gate.input('keyDown');
  expect(gate.take()).toBe(true);
  expect(gate.take()).toBe(false);
});

it('permissions: device pickers, fullscreen and screen sharing are refused, the rest asked per site', () => {
  for (const permission of [
    'fullscreen',
    'automatic-fullscreen',
    'display-capture',
    'keyboardLock',
    'hid',
    'serial',
    'usb',
    'unknown',
    'something-new',
  ])
    expect(permissionRequest(permission)).toEqual({ kind: 'deny' });
  // What Chromium grants without asking (features/browser-tab.md 계약), and nothing else.
  for (const permission of [
    'clipboard-sanitized-write',
    'background-sync',
    'background-fetch',
    'screen-wake-lock',
    'sensors',
    'persistent-storage',
    'mediaKeySystem',
  ]) {
    expect(permissionRequest(permission)).toEqual({ kind: 'grant' });
    expect(permissionCheck(permission)).toEqual({ kind: 'grant' });
  }
  // Chromium asks for any Web MIDI access, SysEx or not.
  expect(permissionRequest('midi')).toEqual({ kind: 'ask', permissions: ['midi'] });
  expect(permissionCheck('midi')).toEqual({ kind: 'stored', permission: 'midi' });
  expect(permissionRequest('midiSysex')).toEqual({ kind: 'ask', permissions: ['midi-sysex'] });
  expect(permissionRequest('notifications')).toEqual({
    kind: 'ask',
    permissions: ['notifications'],
  });
  expect(permissionRequest('media', ['video', 'audio'])).toEqual({
    kind: 'ask',
    permissions: ['camera', 'microphone'],
  });
  expect(permissionRequest('media', ['audio'])).toEqual({
    kind: 'ask',
    permissions: ['microphone'],
  });
  expect(permissionRequest('media', [])).toEqual({ kind: 'deny' });
  expect(permissionRequest('geolocation')).toEqual({ kind: 'ask', permissions: ['geolocation'] });
  expect(permissionRequest('openExternal')).toEqual({
    kind: 'ask',
    permissions: ['open-external'],
  });
  expect(permissionRequest('clipboard-read')).toEqual({
    kind: 'ask',
    permissions: ['clipboard-read'],
  });
  expect(permissionCheck('media', 'video')).toEqual({ kind: 'stored', permission: 'camera' });
  expect(permissionCheck('media', 'unknown')).toEqual({ kind: 'deny' });
  expect(permissionCheck('notifications')).toEqual({
    kind: 'stored',
    permission: 'notifications',
  });
  expect(permissionCheck('hid')).toEqual({ kind: 'deny' });
  expect(permissionCheck('fullscreen')).toEqual({ kind: 'deny' });
  expect(permissionCheck('display-capture')).toEqual({ kind: 'deny' });
  // Never asked, so never remembered or shown under site permissions.
  expect(SITE_PERMISSIONS).not.toContain('display-capture');
});

it('certificate and load errors are named for people, aborted loads are not errors', () => {
  expect(certificateReason('net::ERR_CERT_DATE_INVALID', false)).toBe('expired');
  expect(certificateReason('net::ERR_CERT_COMMON_NAME_INVALID', false)).toBe('name-mismatch');
  expect(certificateReason('net::ERR_CERT_AUTHORITY_INVALID', true)).toBe('self-signed');
  expect(certificateReason('net::ERR_CERT_AUTHORITY_INVALID', false)).toBe('untrusted');
  expect(certificateReason('net::ERR_CERT_REVOKED', false)).toBe('revoked');
  expect(certificateReason('net::ERR_CERT_WEAK_KEY', false)).toBe('other');
  expect(loadFailure(-3)).toBeNull();
  expect(loadFailure(-105)).toBe('name-not-resolved');
  expect(loadFailure(-102)).toBe('connection-refused');
  expect(loadFailure(-118)).toBe('timed-out');
  expect(loadFailure(-106)).toBe('offline');
  expect(loadFailure(-202)).toBe('certificate');
  expect(loadFailure(-1)).toBe('other');
});

it('zoom moves in half levels like the menu roles and stops at Chromium limits', () => {
  expect(zoomLevel(0, 'in')).toBe(0.5);
  expect(zoomLevel(0.5, 'out')).toBe(0);
  expect(zoomLevel(3, 'reset')).toBe(0);
  expect(zoomLevel(100, 'in')).toBeLessThanOrEqual(Math.log(5) / Math.log(1.2));
  expect(zoomLevel(-100, 'out')).toBeGreaterThanOrEqual(Math.log(0.25) / Math.log(1.2));
});

const spot = (over: Partial<Parameters<typeof pageMenu>[0]> = {}) => ({
  linkURL: '',
  mediaType: 'none' as const,
  hasImageContents: false,
  isEditable: false,
  selectionText: '',
  editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false },
  ...over,
});

it("the page's menu has only what applies there, no Inspect, and edit items only on a preview", () => {
  const all = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true };
  // Nothing applies: no menu.
  expect(pageMenu(spot(), false)).toEqual([]);
  expect(pageMenu(spot({ editFlags: all }), false)).toEqual([]);
  // A link; a new tab only for http(s).
  expect(pageMenu(spot({ linkURL: 'https://shop.example/help' }), false)).toEqual([
    ['open-link', 'copy-link'],
  ]);
  expect(pageMenu(spot({ linkURL: 'mailto:help@shop.example' }), false)).toEqual([['copy-link']]);
  expect(pageMenu(spot({ linkURL: 'javascript:void(0)' }), false)).toEqual([['copy-link']]);
  // An empty field: nothing chosen, so no Cut or Copy.
  expect(
    pageMenu(
      spot({
        isEditable: true,
        editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true },
      }),
      false,
    ),
  ).toEqual([['paste', 'select-all']]);
  // Chosen text in a field, and on the page, where Cut and Paste never show.
  expect(pageMenu(spot({ isEditable: true, selectionText: 'abc', editFlags: all }), false)).toEqual(
    [['cut', 'copy', 'paste', 'select-all']],
  );
  expect(pageMenu(spot({ selectionText: 'abc', editFlags: all }), false)).toEqual([
    ['copy', 'select-all'],
  ]);
  // An image once it has a picture; a linked image with chosen text has all three groups.
  expect(pageMenu(spot({ mediaType: 'image', hasImageContents: true }), false)).toEqual([
    ['copy-image'],
  ]);
  expect(pageMenu(spot({ mediaType: 'image' }), false)).toEqual([]);
  expect(pageMenu(spot({ mediaType: 'canvas', hasImageContents: true }), false)).toEqual([]);
  const everything = spot({
    linkURL: 'https://shop.example/help',
    mediaType: 'image',
    hasImageContents: true,
    selectionText: 'help',
    editFlags: all,
  });
  expect(pageMenu(everything, false)).toEqual([
    ['open-link', 'copy-link'],
    ['copy-image'],
    ['copy', 'select-all'],
  ]);
  // A preview page: the edit items only (its links can carry the lease's private path).
  expect(pageMenu(everything, true)).toEqual([['copy', 'select-all']]);
  expect(pageMenu(spot({ linkURL: 'http://127.0.0.2:4321/key/x' }), true)).toEqual([]);
});

it('a page document is told fullscreen is not allowed, over its own policy', () => {
  expect(refuseFullscreen({ 'content-type': ['text/html'] })).toEqual({
    'content-type': ['text/html'],
    'Permissions-Policy': ['fullscreen=()'],
  });
  // Appended under the page's own header name, so it is the last word on fullscreen.
  expect(refuseFullscreen({ 'permissions-policy': ['fullscreen=(self), camera=()'] })).toEqual({
    'permissions-policy': ['fullscreen=(self), camera=()', 'fullscreen=()'],
  });
  expect(refuseFullscreen(undefined)).toEqual({ 'Permissions-Policy': ['fullscreen=()'] });
});
