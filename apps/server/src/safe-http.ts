import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

export const MAX_INPUT_BYTES = 1024 * 1024;
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}
export interface Address {
  address: string;
  family: number;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  close(): void;
}
export interface Network {
  resolve(host: string): Promise<Address[]>;
  request(
    url: URL,
    address: Address,
    signal: AbortSignal,
    headers?: Record<string, string>,
  ): Promise<HttpResponse>;
}

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
blocked.addSubnet('3fff::', 20, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export function sourceUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InputError('invalid HTTPS source');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  ) {
    throw new InputError('only HTTPS sources on port 443 without credentials are accepted');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    (isIP(host) && !publicAddress(host))
  )
    throw new InputError('source address is not public');
  if (
    [...url.searchParams.keys()].some((key) => /key|token|secret|password|authorization/i.test(key))
  ) {
    throw new InputError('source URLs must not contain credentials');
  }
  url.hash = '';
  return url;
}

export const systemNetwork: Network = {
  resolve: (host) => lookup(host, { all: true, verbatim: true }),
  request: (url, address, signal, headers = {}) =>
    new Promise((resolve, reject) => {
      // Pin the checked address. Keep the original hostname for Host, TLS SNI and certificate checks.
      const req = request(
        url,
        {
          agent: false,
          rejectUnauthorized: true,
          signal,
          family: address.family,
          lookup: (_hostname, _options, callback) =>
            callback(null, address.address, address.family),
          headers: {
            accept: 'text/plain, text/markdown',
            'accept-encoding': 'identity',
            ...headers,
          },
        },
        (res) =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: res,
            close: () => res.destroy(),
          }),
      );
      req.on('error', () =>
        reject(
          new InputError(
            signal.aborted ? 'input request cancelled or timed out' : 'input request failed',
          ),
        ),
      );
      req.end();
    }),
};

async function aborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let stop: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new InputError('input request cancelled or timed out'));
    signal.addEventListener('abort', stop, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener('abort', stop);
  }
}

export async function resolvePublic(
  url: URL,
  network: Network,
  signal: AbortSignal,
): Promise<Address> {
  signal.throwIfAborted();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  const addresses = family
    ? [{ address: host, family }]
    : await aborted(network.resolve(host), signal);
  if (!addresses.length || addresses.some((item) => !publicAddress(item.address))) {
    throw new InputError('source DNS includes a non-public address');
  }
  return addresses[0] as Address;
}

export async function readHttps(
  rawUrl: string,
  options: {
    network?: Network;
    signal?: AbortSignal;
    timeoutMs?: number;
    json?: boolean;
    headers?: Record<string, string>;
  } = {},
): Promise<{ text: string; mimeType: string }> {
  const network = options.network ?? systemNetwork;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let url = sourceUrl(rawUrl);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const address = await resolvePublic(url, network, signal);
      signal.throwIfAborted();
      const response = await aborted(
        network.request(url, address, signal, options.headers),
        signal,
      );
      try {
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          // Provider credentials never follow redirects, including redirects on the same host.
          if (options.headers || redirects === 3)
            throw new InputError('source redirect limit reached');
          const location = response.headers.location;
          if (typeof location !== 'string') throw new InputError('invalid source redirect');
          url = sourceUrl(new URL(location, url).href);
          continue;
        }
        if (response.status !== 200) throw new InputError('source returned an unsuccessful status');
        const contentType = response.headers['content-type'];
        const mimeType =
          typeof contentType === 'string' ? contentType.split(';')[0]?.trim().toLowerCase() : '';
        const allowed = options.json ? ['application/json'] : ['text/plain', 'text/markdown'];
        if (!mimeType || !allowed.includes(mimeType))
          throw new InputError('source must be plain text or Markdown');
        const encoding = response.headers['content-encoding'];
        if (encoding && encoding !== 'identity')
          throw new InputError('compressed source bodies are not accepted');
        if (Number(response.headers['content-length']) > MAX_INPUT_BYTES)
          throw new InputError('source exceeds 1 MiB');
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        const iterator = response.body[Symbol.asyncIterator]();
        while (true) {
          const item = await aborted(iterator.next(), signal);
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > MAX_INPUT_BYTES) throw new InputError('source exceeds 1 MiB');
          chunks.push(item.value);
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        if (text.includes('\u0000')) throw new InputError('source is not text');
        return { text, mimeType };
      } finally {
        response.close();
      }
    }
    throw new InputError('source redirect limit reached');
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(
      signal.aborted ? 'input request cancelled or timed out' : 'input request failed',
    );
  }
}
