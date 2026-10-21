import { createHash, createHmac, type Hash, type Hmac } from 'node:crypto';
import { SignatureV4 } from '@smithy/signature-v4';
import { MAX_VAULT_BYTES } from './crypto.ts';

type Data = string | ArrayBuffer | ArrayBufferView;
function bytes(data: Data) {
  return typeof data === 'string'
    ? Buffer.from(data)
    : ArrayBuffer.isView(data)
      ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      : Buffer.from(data);
}
/** Adapter to Node/OpenSSL primitives; request canonicalization/signing belongs to Smithy. */
class Sha256 {
  private value: Hash | Hmac;
  private readonly secret: Data | undefined;
  constructor(secret?: Data) {
    this.secret = secret;
    this.value = this.create();
  }
  private create() {
    return this.secret === undefined
      ? createHash('sha256')
      : createHmac('sha256', bytes(this.secret));
  }
  update(data: Data) {
    this.value.update(bytes(data));
  }
  async digest() {
    return this.value.digest();
  }
  reset() {
    this.value = this.create();
  }
}
export interface VaultS3Config {
  endpoint: string;
  region: string;
  bucket: string;
  key: string;
}
export interface VaultS3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}
export class VaultConflict extends Error {
  constructor() {
    super('The remote vault changed. Download and review it before uploading.');
  }
}
function objectUrl(config: VaultS3Config) {
  const url = new URL(config.endpoint);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
  )
    throw new Error('Use HTTPS or a loopback S3 endpoint without embedded credentials.');
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) ||
    !/^[a-z0-9-]{1,64}$/.test(config.region) ||
    !config.key ||
    config.key.length > 1024 ||
    config.key.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid S3 region, bucket or object key.');
  const encode = (part: string) =>
    encodeURIComponent(part).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${encode(config.bucket)}/${config.key.split('/').map(encode).join('/')}`;
  return url;
}
export class VaultS3Transport {
  private readonly url: URL;
  private readonly signer: SignatureV4;
  private readonly request: typeof fetch;
  private readonly now: () => Date;
  constructor(
    config: VaultS3Config,
    credentials: VaultS3Credentials,
    options: { request?: typeof fetch; now?: () => Date } = {},
  ) {
    this.url = objectUrl(config);
    this.request = options.request ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.signer = new SignatureV4({
      credentials,
      region: config.region,
      service: 's3',
      sha256: Sha256,
      uriEscapePath: false,
    });
  }
  private async call(method: 'GET' | 'PUT', body?: string, etag?: string | null) {
    if (etag && !/^"[^"\r\n]{1,512}"$/.test(etag)) throw new Error('Invalid object revision.');
    const headers: Record<string, string> = { host: this.url.host };
    if (method === 'PUT') {
      headers['content-type'] = 'application/json';
      if (etag) headers['if-match'] = etag;
      else headers['if-none-match'] = '*';
    }
    const signed = await this.signer.sign(
      {
        protocol: this.url.protocol,
        hostname: this.url.hostname,
        ...(this.url.port ? { port: Number(this.url.port) } : {}),
        method,
        path: this.url.pathname,
        headers,
        ...(body !== undefined ? { body } : {}),
      },
      { signingDate: this.now() },
    );
    try {
      return await this.request(this.url, {
        method,
        headers: signed.headers,
        ...(body !== undefined ? { body } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error(
        method === 'PUT'
          ? 'Upload outcome is unknown. Download the remote object before retrying.'
          : 'Could not download the remote vault.',
      );
    }
  }
  async read(): Promise<{ etag: string; body: string } | null> {
    const response = await this.call('GET');
    if (response.status === 404) return null;
    if (!response.ok || !response.body)
      throw new Error('The S3 service refused the vault download.');
    const etag = response.headers.get('etag');
    if (!etag || !/^"[^"\r\n]{1,512}"$/.test(etag))
      throw new Error('The S3 service did not supply an object revision.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_VAULT_BYTES * 2) throw new Error('Remote vault exceeds the size limit.');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return { etag, body: Buffer.concat(chunks).toString('utf8') };
  }
  async write(body: string, expectedEtag: string | null): Promise<{ etag: string }> {
    if (Buffer.byteLength(body) > MAX_VAULT_BYTES * 2)
      throw new Error('Vault exceeds the size limit.');
    const response = await this.call('PUT', body, expectedEtag);
    if (response.status === 409 || response.status === 412) throw new VaultConflict();
    if (!response.ok) throw new Error('The S3 service refused the vault upload.');
    const etag = response.headers.get('etag');
    const readback = await this.read();
    if (!etag || readback?.etag !== etag || readback.body !== body)
      throw new Error('Upload could not be verified. Download the remote vault before retrying.');
    return { etag };
  }
}
