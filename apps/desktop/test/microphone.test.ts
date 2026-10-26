import { expect, it } from 'vitest';
import { studioMicrophoneRequest } from '../src/microphone-policy.ts';

it('microphone eligibility excludes cameras, previews, frames and stale hosts', () => {
  const origin = 'http://127.0.0.1:12345';
  const allowed = (url: string | undefined, main = true, media: string[] = ['audio']) =>
    studioMicrophoneRequest('media', url, origin, main, media);
  expect(allowed(`${origin}/sessions/session_a`)).toBe(true);
  expect(allowed(`${origin}/sessions/session_a`, false)).toBe(false);
  expect(allowed('http://127.0.0.2:12345/index.html')).toBe(false);
  expect(allowed('http://127.0.0.1:12346/')).toBe(false);
  expect(allowed('corral://hosts/')).toBe(false);
  expect(allowed(origin, true, ['audio', 'video'])).toBe(false);
  expect(allowed(origin, true, ['video'])).toBe(false);
  expect(allowed(undefined)).toBe(false);
  expect(studioMicrophoneRequest('notifications', origin, origin, true, ['audio'])).toBe(false);
  expect(studioMicrophoneRequest('media', origin, null, true, ['audio'])).toBe(false);
});
