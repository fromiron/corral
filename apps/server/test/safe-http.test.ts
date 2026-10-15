import { describe, expect, it } from 'vitest';
import {
  MAX_INPUT_BYTES,
  type Network,
  publicAddress,
  readHttps,
  sourceUrl,
} from '../src/safe-http.ts';

const response = (text = 'Safe text', headers: Record<string, string> = {}, status = 200) => ({
  status,
  headers: { 'content-type': 'text/plain', ...headers },
  body: (async function* () {
    yield Buffer.from(text);
  })(),
  close() {},
});
const network = (overrides: Partial<Network> = {}): Network => ({
  resolve: async () => [{ address: '8.8.8.8', family: 4 }],
  request: async () => response(),
  ...overrides,
});

describe('registered HTTPS input boundary (C-043)', () => {
  it('[TC-SEC-003-N] blocks private, special, mapped and transition addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '100.64.1.1',
      '169.254.169.254',
      '192.168.1.1',
      '224.0.0.1',
      '::1',
      '::',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '64:ff9b::7f00:1',
      '2002:7f00:1::',
      '2001:db8::1',
    ]) {
      expect(publicAddress(address), address).toBe(false);
    }
    for (const address of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111'])
      expect(publicAddress(address)).toBe(true);
  });
  it('[TC-SEC-003-H] pins checked DNS to the connection and accepts bounded UTF-8 text', async () => {
    let lookups = 0;
    let pin = '';
    const result = await readHttps('https://source.example/doc', {
      network: network({
        resolve: async () => [{ address: ++lookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }],
        request: async (url, address) => {
          pin = address.address;
          expect(url.hostname).toBe('source.example');
          return response('한글');
        },
      }),
    });
    expect(result).toEqual({ text: '한글', mimeType: 'text/plain' });
    expect(lookups).toBe(1);
    expect(pin).toBe('8.8.8.8');
  });
  it('rejects every unsafe address in mixed DNS and revalidates each redirect', async () => {
    let calls = 0;
    await expect(
      readHttps('https://source.example', {
        network: network({
          resolve: async () => [
            { address: '8.8.8.8', family: 4 },
            { address: '::1', family: 6 },
          ],
          request: async () => {
            calls++;
            return response();
          },
        }),
      }),
    ).rejects.toThrow(/non-public/);
    expect(calls).toBe(0);
    await expect(
      readHttps('https://source.example', {
        network: network({
          request: async () => response('', { location: 'https://[::1]/secret' }, 302),
        }),
      }),
    ).rejects.toThrow(/not public/);
  });
  it('rejects paths, userinfo, non-HTTPS, nonstandard ports and query credentials', () => {
    for (const url of [
      '/etc/passwd',
      'file:///etc/passwd',
      'http://source.example',
      'https://u:p@source.example',
      'https://source.example:8443',
      'https://source.example?token=secret',
      'https://2130706433/',
    ]) {
      expect(() => sourceUrl(url)).toThrow();
    }
  });
  it('limits redirects, MIME, declared/streamed size and never executes HTML', async () => {
    for (const res of [
      response('<script>bad()</script>', { 'content-type': 'text/html' }),
      response('', { 'content-length': String(MAX_INPUT_BYTES + 1) }),
      response('x'.repeat(MAX_INPUT_BYTES + 1)),
      response('', { location: '/again' }, 302),
    ]) {
      await expect(
        readHttps('https://source.example', { network: network({ request: async () => res }) }),
      ).rejects.toThrow();
    }
  });
  it('does not start DNS or HTTP work for an already cancelled request', async () => {
    let work = 0;
    const abort = new AbortController();
    abort.abort();
    for (const url of ['https://source.example', 'https://8.8.8.8']) {
      await expect(
        readHttps(url, {
          signal: abort.signal,
          network: network({
            resolve: async () => {
              work++;
              return [{ address: '8.8.8.8', family: 4 }];
            },
            request: async () => {
              work++;
              return response();
            },
          }),
        }),
      ).rejects.toThrow();
    }
    expect(work).toBe(0);
  });
  it('bounds DNS and body time, honours cancellation, and hides upstream error details', async () => {
    await expect(
      readHttps('https://source.example', {
        timeoutMs: 5,
        network: network({ resolve: () => new Promise(() => {}) }),
      }),
    ).rejects.toThrow(/timed out/);
    const abort = new AbortController();
    abort.abort();
    await expect(
      readHttps('https://source.example', { signal: abort.signal, network: network() }),
    ).rejects.toThrow(/cancelled/);
    await expect(
      readHttps('https://source.example', {
        network: network({
          request: async () => {
            throw new Error('/home/private secret-key');
          },
        }),
      }),
    ).rejects.toThrow('input request failed');
  });
});
