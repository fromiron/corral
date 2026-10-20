import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encryptVault } from '../src/vault/crypto.ts';
import { VaultService, vaultRevision } from '../src/vault/service.ts';
import type { VaultDomainAdapter } from '../src/vault/types.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const password = 'long local recovery password';
const prefs = {
  version: 1 as const,
  theme: 'light' as const,
  locale: 'en' as const,
  sendKey: 'enter' as const,
  notify: false,
};
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'corral-vault-'));
  dirs.push(dir);
  return dir;
}
function domain(initial: unknown) {
  let value = initial;
  const adapter: VaultDomainAdapter = {
    async capture() {
      return { revision: vaultRevision(value), value };
    },
    async preview(value) {
      return { value, warnings: [] };
    },
    async apply(next, revision) {
      if (revision !== vaultRevision(value)) throw new Error('revision conflict');
      value = next;
      return { revision: vaultRevision(value) };
    },
    async restore(snapshot, revision) {
      return adapter.apply(snapshot.value, revision, 'restore');
    },
  };
  return adapter;
}
describe('[TC-ABS-013-H] vault application journal', () => {
  it('waits for real browser preference readback before marking the operation complete', async () => {
    const dir = directory();
    const service = new VaultService({ directory: dir, adapters: () => ({}) });
    const target = { ...prefs, theme: 'dark' as const };
    const envelope = await service.capture(['application'], password, target);
    const preview = await service.preview(envelope, password, prefs);
    expect(preview.entries).toMatchObject([
      { domain: 'application', available: true, changed: true },
    ]);
    const pending = await service.apply(preview.previewId, ['application'], password);
    expect(pending.status).toBe('pending_client_apply');
    expect(readFileSync(join(dir, 'apply-journal.json'), 'utf8')).not.toContain('"dark"');
    const restarted = new VaultService({ directory: dir, adapters: () => ({}) });
    expect((await restarted.pending(password)).application?.target).toEqual(target);
    await expect(restarted.acknowledge(pending.id, password, prefs)).rejects.toThrow('readback');
    expect((await restarted.acknowledge(pending.id, password, target)).status).toBe('committed');
  });
});
describe('[TC-ABS-013-N] partial apply and stale revisions', () => {
  it('reads both forward and rollback owner receipts when the process loses their journal acknowledgements', async () => {
    let value = { original: true };
    let revision = 1;
    const receipts = new Map<string, { revision: string }>();
    let loseForward = true;
    let loseRollback = true;
    const adapter: VaultDomainAdapter = {
      async capture() {
        return { revision: String(revision), value };
      },
      async preview(value) {
        return { value, warnings: [] };
      },
      async apply(next, expected, operationId) {
        const existing = receipts.get(operationId);
        if (existing) return existing;
        if (expected !== String(revision)) throw new Error('revision conflict');
        value = next as typeof value;
        const receipt = { revision: String(++revision) };
        receipts.set(operationId, receipt);
        if (loseForward) {
          loseForward = false;
          throw new Error('journal acknowledgement lost');
        }
        return receipt;
      },
      async restore(snapshot, expected, operationId) {
        const result = await adapter.apply(snapshot.value, expected, operationId);
        if (loseRollback) {
          loseRollback = false;
          throw new Error('rollback acknowledgement lost');
        }
        return result;
      },
      async receipt(id) {
        return receipts.get(id) ?? null;
      },
    };
    const dir = directory();
    const options = { directory: dir, adapters: () => ({ instructions: adapter }) };
    const service = new VaultService(options);
    const envelope = await encryptVault(
      {
        version: 1,
        createdAt: new Date().toISOString(),
        domains: { instructions: { revision: 'source', value: { original: false } } },
      },
      password,
    );
    const preview = await service.preview(envelope, password, prefs);
    await expect(service.apply(preview.previewId, ['instructions'], password)).rejects.toThrow(
      'acknowledgement lost',
    );
    await expect(new VaultService(options).rollback(password)).rejects.toThrow(
      'rollback acknowledgement lost',
    );
    expect(revision).toBe(3);
    expect((await new VaultService(options).rollback(password)).status).toBe('rolled_back');
    expect(revision).toBe(3);
    expect(value).toEqual({ original: true });
  });
  it('repeated rollback keeps the original browser target and requires readback acknowledgement', async () => {
    const service = new VaultService({ directory: directory(), adapters: () => ({}) });
    const target = { ...prefs, theme: 'dark' as const };
    const envelope = await service.capture(['application'], password, target);
    const preview = await service.preview(envelope, password, prefs);
    await service.apply(preview.previewId, ['application'], password);
    const first = await service.rollback(password);
    const repeated = await service.rollback(password);
    expect(repeated.application?.target).toEqual(prefs);
    expect(repeated).toEqual(first);
    expect((await service.acknowledge(first.id, password, prefs)).status).toBe('rolled_back');
  });
  it('retains a recoverable journal, rolls back completed domains and preserves untouched ones', async () => {
    const first = domain({ original: true });
    const second = domain({ untouched: true });
    second.apply = async () => {
      throw new Error('owner refused');
    };
    const dir = directory();
    const service = new VaultService({
      directory: dir,
      adapters: () => ({ providers: first, automation: second }),
    });
    const encrypted = await encryptVault(
      {
        version: 1,
        createdAt: new Date().toISOString(),
        domains: {
          providers: { revision: 'source1', value: { imported: true } },
          automation: { revision: 'source2', value: { imported: true } },
        },
      },
      password,
    );
    const preview = await service.preview(encrypted, password, prefs);
    await expect(
      service.apply(preview.previewId, ['providers', 'automation'], password),
    ).rejects.toThrow('recover');
    expect((await first.capture()).value).toEqual({ imported: true });
    const restarted = new VaultService({
      directory: dir,
      adapters: () => ({ providers: first, automation: second }),
    });
    expect((await restarted.rollback(password)).status).toBe('rolled_back');
    expect((await first.capture()).value).toEqual({ original: true });
    expect((await second.capture()).value).toEqual({ untouched: true });
  });
});
