import { expect, it } from 'vitest';
import { externalUrl, localRoute, trustedSender } from '../src/security.ts';

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

// CR-017: native menu commands, theme, notifications and recent workspaces.
import {
  DESKTOP_COMMANDS,
  desktopCommand,
  notificationText,
  recentWorkspaces,
  themeColors,
} from '../src/security.ts';

it('[CR-017] the menu sends only known command names to the page', () => {
  for (const id of DESKTOP_COMMANDS) expect(desktopCommand(id)).toBe(id);
  for (const value of ['run.stop', 'eval', '', null, 42, { id: 'palette' }, 'palette '])
    expect(desktopCommand(value)).toBeNull();
});

it('[CR-017] the theme sets colours only from a boolean', () => {
  expect(themeColors(true)?.background).toMatch(/^#[0-9a-f]{6}$/);
  expect(themeColors(false)?.background).not.toBe(themeColors(true)?.background);
  for (const value of ['dark', 1, null, undefined, {}]) expect(themeColors(value)).toBeNull();
});

it('[CR-017] notifications carry short plain text only', () => {
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

it('[CR-017] recent workspaces keep five absolute, distinct paths, newest first', () => {
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
