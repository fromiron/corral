import type {
  PortableApplication,
  VaultApplyResult,
  VaultBindings,
  VaultCaptureRequest,
  VaultDomain,
  VaultPreview,
  VaultS3Connection,
  VaultStatus,
} from './vault.ts';

/** Uses the same authenticated/CSRF HTTP owner as the other client services. */
export interface VaultHttp {
  json<T>(path: string, init?: RequestInit): Promise<T>;
}
export class VaultClient {
  private readonly http: VaultHttp;
  constructor(http: VaultHttp) {
    this.http = http;
  }
  state(): Promise<VaultStatus> {
    return this.http.json('/vault');
  }
  options(bindings: VaultBindings): Promise<VaultStatus> {
    return this.post('/vault/options', { bindings });
  }
  capture(input: VaultCaptureRequest): Promise<{ envelope: unknown }> {
    return this.post('/vault/export', input);
  }
  preview(input: {
    envelope: unknown;
    password: string;
    application: PortableApplication;
    bindings: VaultBindings;
  }): Promise<VaultPreview> {
    return this.post('/vault/preview', input);
  }
  apply(input: {
    previewId: string;
    password: string;
    domains: VaultDomain[];
  }): Promise<VaultApplyResult> {
    return this.post('/vault/apply', input);
  }
  pending(password: string): Promise<VaultApplyResult> {
    return this.post('/vault/pending', { password });
  }
  acknowledge(input: {
    id: string;
    password: string;
    application: PortableApplication;
  }): Promise<VaultApplyResult> {
    return this.post('/vault/acknowledge', input);
  }
  rollback(password: string): Promise<VaultApplyResult> {
    return this.post('/vault/rollback', { password });
  }
  saveConnection(input: VaultS3Connection): Promise<{ configured: boolean }> {
    return this.http.json('/vault/s3', { method: 'PUT', body: JSON.stringify(input) });
  }
  download(password: string): Promise<{ etag: string | null; envelope: unknown }> {
    return this.post('/vault/s3/download', { password });
  }
  upload(input: VaultCaptureRequest & { expectedEtag: string | null }): Promise<{ etag: string }> {
    return this.post('/vault/s3/upload', input);
  }
  private post<T>(path: string, body: unknown): Promise<T> {
    return this.http.json(path, { method: 'POST', body: JSON.stringify(body) });
  }
}
