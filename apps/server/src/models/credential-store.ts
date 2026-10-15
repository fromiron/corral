import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';

// pi-ai's CredentialStore on one file (0600, in a 0700 directory). Writes go through
// `modify`, one provider at a time, and replace the file atomically. Nothing here logs or
// returns a token except to pi-ai, which resolves request auth from it (ADR-019).

interface FileShape {
  version: 1;
  credentials: Record<string, Credential>;
}

export class FileCredentialStore implements CredentialStore {
  private readonly dir: string;
  private readonly file: string;
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(dir: string) {
    this.dir = dir;
    this.file = join(dir, 'credentials.json');
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
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/** A stable id for this installation, sent to OpenAI as its agent host id. */
export function installationId(dir: string): string {
  const file = join(dir, 'device-id');
  if (existsSync(file)) return readFileSync(file, 'utf-8').trim();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  writeFileSync(file, id, { mode: 0o600 });
  return id;
}
