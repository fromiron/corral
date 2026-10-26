import { describe, expect, it } from 'vitest';
import { decryptVault, encryptVault } from '../src/vault/crypto.ts';

describe('encrypted portable configuration', () => {
  it('round trips supported domain snapshots with independent salt and nonce', async () => {
    const value = {
      version: 1 as const,
      createdAt: '2026-10-20T00:00:00.000Z',
      domains: { application: { revision: 'a', value: { theme: 'dark' } } },
    };
    const first = await encryptVault(value, 'a long local recovery password');
    const second = await encryptVault(value, 'a long local recovery password');
    expect(first).not.toEqual(second);
    expect(JSON.stringify(first)).not.toContain('dark');
    expect(await decryptVault(first, 'a long local recovery password')).toEqual(value);
  });
});
describe('unauthenticated vault data', () => {
  it('refuses wrong passwords, modified ciphertext, changed versions and unbounded KDF parameters', async () => {
    const value = { version: 1 as const, createdAt: '2026-10-20T00:00:00.000Z', domains: {} };
    const envelope = await encryptVault(value, 'a long local recovery password');
    await expect(decryptVault(envelope, 'another password entirely')).rejects.toThrow(
      'authentication',
    );
    await expect(
      decryptVault(
        { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -8)}AAAAAAAA` },
        'a long local recovery password',
      ),
    ).rejects.toThrow();
    await expect(
      decryptVault({ ...envelope, version: 2 }, 'a long local recovery password'),
    ).rejects.toThrow();
    await expect(
      decryptVault(
        { ...envelope, kdf: { name: 'scrypt', N: 1073741824 } },
        'a long local recovery password',
      ),
    ).rejects.toThrow();
  });
});
