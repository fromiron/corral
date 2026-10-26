import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '@corral/contracts';
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';
import { ensurePrivateDirectory, protectPrivatePaths } from '../private-files.ts';

// pi-ai's CredentialStore on one file (0600, in a 0700 directory). Writes go through
// `modify`, one provider at a time, and replace the file atomically. Nothing here logs or
// returns a token except to pi-ai, which resolves request auth from it.

interface FileShape {
  version: 1;
  credentials: Record<string, Credential>;
  operations?: Record<string, VaultCredentialReceipt>;
  vaultKey?: string;
}

export interface VaultCredentialReceipt {
  requestHash: string;
  credentialHash: string;
  revision: string;
}
export interface VaultCredentialOwner {
  fingerprintForVault(value: unknown): Promise<string>;
  readOwnForVault(): Promise<Record<string, Credential>>;
  receiptForVault(operationId: string): Promise<VaultCredentialReceipt | null>;
  applyForVault(input: {
    operationId: string;
    requestHash: string;
    expectedHash: string;
    revision: string;
    credentials: Record<string, Credential>;
    canCommit(): boolean;
  }): Promise<VaultCredentialReceipt>;
}

export class FileCredentialStore implements CredentialStore {
  private readonly dir: string;
  private readonly file: string;
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(dir: string) {
    this.dir = dir;
    this.file = join(dir, 'credentials.json');
    // Upgrade files created by earlier Windows versions before reading their credentials.
    if (existsSync(this.file)) protectPrivatePaths([this.dir, this.file]);
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.load().credentials[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.load().credentials).map(([providerId, c]) => ({
      providerId,
      type: c.type,
    }));
  }

  async readOwnForVault() {
    return this.load().credentials;
  }
  private keyedFingerprint(value: unknown, data: FileShape) {
    if (!data.vaultKey) {
      data.vaultKey = randomBytes(32).toString('hex');
      this.save(data);
    }
    if (!/^[a-f0-9]{64}$/.test(data.vaultKey)) throw new Error('Vault fingerprint key is invalid.');
    return createHmac('sha256', Buffer.from(data.vaultKey, 'hex'))
      .update(canonicalJson(value))
      .digest('hex');
  }
  async fingerprintForVault(value: unknown) {
    return this.keyedFingerprint(value, this.load());
  }
  async receiptForVault(operationId: string) {
    return this.load().operations?.[operationId] ?? null;
  }
  applyForVault(
    input: Parameters<VaultCredentialOwner['applyForVault']>[0],
  ): Promise<VaultCredentialReceipt> {
    const keys = [
      ...new Set([...Object.keys(this.load().credentials), ...Object.keys(input.credentials)]),
    ];
    const run = Promise.all(keys.map((key) => this.chains.get(key) ?? Promise.resolve())).then(
      () => {
        const data = this.load();
        const previous = data.operations?.[input.operationId];
        if (previous) {
          if (previous.requestHash !== input.requestHash)
            throw new Error('Credential operation identity changed.');
          return previous;
        }
        if (
          this.keyedFingerprint(data.credentials, data) !== input.expectedHash ||
          !input.canCommit()
        )
          throw new Error('Credentials or endpoint settings changed during vault application.');
        const receipt = {
          requestHash: input.requestHash,
          credentialHash: this.keyedFingerprint(input.credentials, data),
          revision: input.revision,
        };
        this.save({
          ...data,
          credentials: input.credentials,
          operations: { ...data.operations, [input.operationId]: receipt },
        });
        return receipt;
      },
    );
    for (const key of keys)
      this.chains.set(
        key,
        run.catch(() => {}),
      );
    return run;
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.serialize(providerId, async () => {
      const data = this.load();
      const next = await fn(data.credentials[providerId]);
      if (next === undefined) return data.credentials[providerId];
      // Re-read: another provider may have been written while `fn` ran.
      const latest = this.load();
      latest.credentials[providerId] = next;
      this.save(latest);
      return next;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.serialize(providerId, async () => {
      const data = this.load();
      delete data.credentials[providerId];
      this.save(data);
    });
  }

  private serialize<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.chains.set(
      providerId,
      run.catch(() => {}),
    );
    return run;
  }

  private load(): FileShape {
    if (!existsSync(this.file)) return { version: 1, credentials: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as FileShape;
      if (parsed.version !== 1 || typeof parsed.credentials !== 'object') throw new Error();
      return parsed;
    } catch {
      throw new Error('The saved sign-in file cannot be read; sign in again.');
    }
  }

  private save(data: FileShape) {
    // Protect the parent before creating the temporary file, so its Windows ACL is private
    // from creation rather than only after the credential has already been written.
    ensurePrivateDirectory(this.dir);
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, this.file);
  }
}

/** A stable id for this installation, sent to OpenAI as its agent host id. */
export function installationId(dir: string): string {
  const file = join(dir, 'device-id');
  if (existsSync(file)) return readFileSync(file, 'utf-8').trim();
  ensurePrivateDirectory(dir);
  const id = randomUUID();
  writeFileSync(file, id, { mode: 0o600 });
  return id;
}
