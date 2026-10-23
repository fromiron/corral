import { expect, it } from 'vitest';
import { InteractiveRequestLimiter, RequestLimiter } from '../src/security.ts';

it('[TC-WBD-004-H] allows ordinary terminal typing without spending the general mutation budget', () => {
  let now = 0;
  const input = new InteractiveRequestLimiter(() => now);
  const requests = new RequestLimiter(() => now);
  for (let second = 0; second < 30; second++) {
    now = second * 1000;
    for (let key = 0; key < 10; key++) expect(input.allow(1)).toBe(true);
  }
  for (let write = 0; write < 120; write++) expect(requests.allow(true)).toBe(true);
  expect(requests.allow(true)).toBe(false);
});

it('[TC-WBD-004-N] bounds both input frames and UTF-8 bytes without an attacker-controlled key map', () => {
  let now = 0;
  const input = new InteractiveRequestLimiter(() => now);
  for (let frame = 0; frame < 120; frame++) expect(input.allow(1)).toBe(true);
  expect(input.allow(1)).toBe(false);
  now = 1000;
  expect(input.allow(256 * 1024)).toBe(true);
  expect(input.allow(Buffer.byteLength('가'))).toBe(false);
  now = 2000;
  expect(input.allow(Buffer.byteLength('가'))).toBe(true);
});
