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
