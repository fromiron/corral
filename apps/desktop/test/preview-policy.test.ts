import { expect, it } from 'vitest';
import { previewRequestAllowed, validatePreviewTarget } from '../src/preview-policy.ts';

it('[TC-ABS-004-H] native preview confines HTTP and WebSocket requests to its authority', () => {
  const target = validatePreviewTarget({
    url: 'http://127.0.0.2:4321/app/',
    origin: 'http://127.0.0.2:4321',
    webSocketOrigins: ['ws://127.0.0.2:4321'],
    headers: { 'x-corral-preview': 'secret' },
  });
  expect(previewRequestAllowed(target, `${target.origin}/app/main.js`)).toBe(true);
  expect(previewRequestAllowed(target, 'ws://127.0.0.2:4321/hmr')).toBe(true);
  for (const url of [
    'http://127.0.0.1:4321/api/v1/settings',
    'http://127.0.0.2:4322',
    'https://example.com/',
    'file:///C:/secret',
    'data:text/html,body',
    'ws://127.0.0.2:4322/hmr',
  ])
    expect(previewRequestAllowed(target, url)).toBe(false);
});

it('[TC-ABS-004-N] malformed authority and static-prefix escapes are refused', () => {
  const target = {
    url: 'http://127.0.0.2:4321/key/index.html',
    origin: 'http://127.0.0.2:4321',
    pathPrefix: '/key/',
    headers: {},
  };
  expect(previewRequestAllowed(target, `${target.origin}/other/index.html`)).toBe(false);
  expect(previewRequestAllowed(target, `${target.origin}/key/../private`)).toBe(false);
  expect(() => validatePreviewTarget({ ...target, origin: 'http://127.0.0.1:4321' })).toThrow();
  expect(() => validatePreviewTarget({ ...target, headers: { Cookie: 'app=secret' } })).toThrow();
  expect(() =>
    validatePreviewTarget({ ...target, webSocketOrigins: ['ws://example.com'] }),
  ).toThrow();
});
