import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { externalUrl, localRoute, trustedSender } from '../src/security.ts';
import { studioDesktopBindings } from './studio-shortcuts.ts';

it('[DW-07] desktop capabilities accept the app main frame only', () => {
  const origin = 'http://127.0.0.1:4317';
  expect(trustedSender(`${origin}/sessions/session_1`, origin, 'corral://startup', true)).toBe(
    true,
  );
  for (const url of [
    'http://127.0.0.1:4318/',
    'https://example.com',
    'http://127.0.0.1:4317.evil.test/',
    'file:///etc/passwd',
  ])
    expect(trustedSender(url, origin, 'corral://startup', true)).toBe(false);
  expect(trustedSender(origin, origin, 'corral://startup', false)).toBe(false);
  expect(trustedSender('corral://startup/', origin, 'corral://startup/', true)).toBe(true);
});

it('[DW-07] external navigation and restored routes cannot execute native schemes or carry a bootstrap token', () => {
  expect(externalUrl('https://github.com/fromiron/corral')).toBe(
    'https://github.com/fromiron/corral',
  );
  for (const url of [
    'file:///tmp/run',
    'javascript:alert(1)',
    'data:text/html,x',
    'https://user:pass@example.com/',
    'mailto:test@example.com',
  ])
    expect(externalUrl(url)).toBeNull();
  expect(localRoute('/sessions/s?tab=team#bootstrap=secret')).toBe('/sessions/s?tab=team');
  for (const url of ['//evil.test', 'https://evil.test', '/\\evil.test', 'bad'])
    expect(localRoute(url)).toBe('/');
});

// native menu commands, theme, notifications and recent workspaces.
import {
  DESKTOP_COMMANDS,
  desktopAccelerators,
  desktopCommand,
  notificationText,
  recentWorkspaces,
  themeColors,
} from '../src/security.ts';

it('the menu sends only known command names to the page', () => {
  for (const id of DESKTOP_COMMANDS) expect(desktopCommand(id)).toBe(id);
  for (const value of ['run.stop', 'eval', '', null, 42, { id: 'palette' }, 'palette '])
    expect(desktopCommand(value)).toBeNull();
});

it('native shortcuts cannot bind unknown commands, edit keys or duplicate chords', () => {
  expect(desktopAccelerators({ palette: { mod: true, shift: true, key: 'k' } })).toEqual({
    palette: 'CommandOrControl+Shift+K',
  });
  expect(desktopAccelerators({})).toEqual({});
  for (const value of [
    { quit: { mod: true, key: 'b' } },
    { palette: { key: 'k' } },
    { palette: { mod: true, key: 'q' } },
    { palette: { mod: true, alt: true, key: 'v' } },
    { palette: { mod: true, key: 'k' }, help: { mod: true, key: 'k' } },
  ])
    expect(() => desktopAccelerators(value)).toThrow();
});

it("the studio's whole default map reaches the native menu; a chord the menu cannot hold is skipped", () => {
  const bindings = studioDesktopBindings();
  expect(bindings['reply.quote']).toEqual({ alt: true, key: 'q' });
  expect(desktopAccelerators(bindings)).toEqual({
    palette: 'CommandOrControl+K',
    help: 'CommandOrControl+/',
    'session.new': 'CommandOrControl+N',
    'view.sidebar': 'CommandOrControl+B',
    'view.panel': 'CommandOrControl+Alt+B',
    'composer.focus': 'CommandOrControl+L',
    settings: 'CommandOrControl+,',
    'nav.back': 'CommandOrControl+[',
    'nav.forward': 'CommandOrControl+]',
  });
  // A rebinding next to the Alt-only quote still reaches the menu.
  expect(
    desktopAccelerators({
      ...bindings,
      'reply.quote': { alt: true, shift: true, key: 'q' },
      palette: { mod: true, shift: true, key: 'p' },
    }),
  ).toMatchObject({ palette: 'CommandOrControl+Shift+P' });
  // A chord the page keeps for itself still counts against a clash with a menu chord.
  expect(() => desktopAccelerators({ ...bindings, 'view.dock': { mod: true, key: 'k' } })).toThrow(
    'Conflicting',
  );
  // The annotation mode's chord too: it is the browser tab's, never a menu accelerator.
  expect(() =>
    desktopAccelerators({ ...bindings, 'browser.annotate': { mod: true, key: 'n' } }),
  ).toThrow('Conflicting');
  for (const value of [
    { 'view.dock': { mod: 'yes', key: 'j' } },
    { 'reply.quote': { alt: true, key: 'q', extra: true } },
  ])
    expect(() => desktopAccelerators(value)).toThrow();
});

it('the preload passes on exactly the commands the menu can send', () => {
  const preload = readFileSync(resolve(import.meta.dirname, '../src/preload.cjs'), 'utf8');
  const list = /const COMMANDS = new Set\(\[([^\]]*)\]\)/.exec(preload)?.[1] ?? '';
  const ids = [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids)).toEqual(new Set(DESKTOP_COMMANDS));
});

it('the theme sets colours only from a boolean', () => {
  expect(themeColors(true)?.background).toMatch(/^#[0-9a-f]{6}$/);
  expect(themeColors(false)?.background).not.toBe(themeColors(true)?.background);
  for (const value of ['dark', 1, null, undefined, {}]) expect(themeColors(value)).toBeNull();
});

it('notifications carry short plain text only', () => {
  expect(notificationText({ title: 'Decision needed', body: 'Session A' })).toEqual({
    title: 'Decision needed',
    body: 'Session A',
  });
  const long = notificationText({ title: 'x'.repeat(500), body: 'y'.repeat(2000) });
  expect(long?.title.length).toBeLessThanOrEqual(120);
  expect(long?.body.length).toBeLessThanOrEqual(300);
  expect(notificationText({ title: 'a\u0000b\u001b[31m', body: '' })).toEqual({
    title: 'ab[31m',
    body: '',
  });
  for (const value of [null, 'x', { title: 3, body: '' }, { title: '', body: 'x' }])
    expect(notificationText(value)).toBeNull();
});

it('recent workspaces keep five absolute, distinct paths, newest first', () => {
  expect(recentWorkspaces(['/a', '/b'], '/b')).toEqual(['/b', '/a']);
  expect(recentWorkspaces(['/1', '/2', '/3', '/4', '/5'], '/6')).toEqual([
    '/6',
    '/1',
    '/2',
    '/3',
    '/4',
  ]);
  expect(recentWorkspaces(['relative', 42, '/ok'] as unknown[], '/new')).toEqual(['/new', '/ok']);
});

it('notification destinations accept identities only, without URLs or host selectors', async () => {
  const { notificationTarget } = await import('../src/security.ts');
  const target = { kind: 'decision', sessionId: 'session_a', runId: 'run_a' };
  expect(notificationTarget(target)).toEqual(target);
  for (const value of [
    null,
    {},
    '/sessions/session_a',
    { ...target, url: 'https://example.com' },
    { ...target, hostId: 'remote' },
    { ...target, sessionId: '../other' },
    { ...target, runId: null },
    { ...target, kind: 'unknown' },
  ])
    expect(notificationTarget(value)).toBeNull();
  expect(notificationTarget({ kind: 'queued', sessionId: 'session_a', runId: null })).toEqual({
    kind: 'queued',
    sessionId: 'session_a',
    runId: null,
  });
  expect(notificationTarget({ kind: 'pull_request', sessionId: 'session_a', runId: null })).toEqual(
    { kind: 'pull_request', sessionId: 'session_a', runId: null },
  );
});

it('terminal notifications require an exact terminal identity and do not accept it on other kinds', async () => {
  const { notificationTarget } = await import('../src/security.ts');
  const target = {
    kind: 'uncertain_terminal',
    sessionId: 'session_a',
    runId: null,
    terminalId: 'pty_a',
  };
  expect(notificationTarget(target)).toEqual(target);
  for (const value of [
    { ...target, terminalId: undefined },
    { ...target, terminalId: '../other' },
    { ...target, terminalId: 'https://example.test' },
    { ...target, runId: 'run_a' },
    { ...target, kind: 'queued' },
  ])
    expect(notificationTarget(value)).toBeNull();
});

it('advice notifications require the exact run and execution row and do not accept it on other kinds', async () => {
  const { notificationTarget } = await import('../src/security.ts');
  const target = {
    kind: 'advice',
    sessionId: 'session_a',
    runId: 'run_a',
    executionId: 'exec_a',
  };
  expect(notificationTarget(target)).toEqual(target);
  for (const value of [
    { ...target, executionId: undefined },
    { ...target, executionId: '../other' },
    { ...target, runId: null },
    { ...target, terminalId: 'pty_a' },
    { ...target, kind: 'decision' },
    { kind: 'queued', sessionId: 'session_a', runId: null, executionId: 'exec_a' },
  ])
    expect(notificationTarget(value)).toBeNull();
});
