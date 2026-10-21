import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileCredentialStore, type VaultCredentialOwner } from '../src/models/credential-store.ts';
import { ModelRegistry } from '../src/models/registry.ts';
import { FAKE_PROFILES, fakeOpenAI } from '../src/testing.ts';
import { providersVaultAdapter } from '../src/vault/providers.ts';
import { prepareWorkspace, readWorkspaceConfig, writeModelConfig } from '../src/workspace.ts';

// Recovery reconstructs private stores and verifies several real Windows ACL-protected writes.
if (process.platform === 'win32') vi.setConfig({ testTimeout: 20_000 });

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'corral-vault-owner-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe('[TC-ABS-013-N] model owner crash checkpoints', () => {
  it('keeps credential checkpoint fingerprints private to one installation', async () => {
    const directory = temp();
    const first = new FileCredentialStore(directory);
    const other = new FileCredentialStore(temp());
    const value = { openai: { type: 'api_key', key: 'short-local-test-key' } };
    const fingerprint = await first.fingerprintForVault(value);
    expect(await other.fingerprintForVault(value)).not.toBe(fingerprint);
    expect(await new FileCredentialStore(directory).fingerprintForVault(value)).toBe(fingerprint);
    expect(await first.readOwnForVault()).toEqual({});
  });
  it('keeps a borrowed Codex login outside portable and rollback credential state', async () => {
    const configDir = temp();
    const fake = fakeOpenAI({ configDir, codexLogin: { mode: 0o600 } });
    const workspace = prepareWorkspace(temp());
    const registry = new ModelRegistry(fake.live.models, FAKE_PROFILES, {
      credentials: fake.live.credentials,
      getDeviceId: () => 'fixture',
    });
    const adapter = providersVaultAdapter({ workspace, registry, live: fake.live });
    const before = await adapter.capture({ purpose: 'rollback' });
    expect(before.value).toHaveProperty('localCredentials', {});
    await expect(
      adapter.capture({ purpose: 'export', includeSecrets: ['openai'] }),
    ).rejects.toThrow('Only explicitly selected API keys');
    const draft = await adapter.preview({ modelProfiles: FAKE_PROFILES, modelProviders: [] }, {});
    await adapter.apply(draft.value, before.revision, 'borrowed-preserved');
    await registry.refreshStatus();
    expect(registry.authView().find((provider) => provider.providerId === 'openai')).toMatchObject({
      source: 'codex-cli',
      method: 'oauth',
    });
    expect(readFileSync(join(configDir, 'credentials.json'), 'utf8')).not.toContain(
      '"type":"oauth"',
    );
  });
  it.each(['before', 'after'] as const)(
    'recovers a crash %s the atomic credential commit without replaying the import',
    async (stage) => {
      const configDir = temp();
      const workspace = prepareWorkspace(temp());
      const base = writeModelConfig(
        workspace.root,
        { modelProfiles: FAKE_PROFILES, modelProviders: [] },
        workspace.configRevision,
      );
      if (!base.ok) throw new Error();
      workspace.config = base.config;
      workspace.configRevision = base.revision;
      const fake = fakeOpenAI({ configDir });
      class CrashingStore extends FileCredentialStore {
        override async applyForVault(
          input: Parameters<VaultCredentialOwner['applyForVault']>[0],
        ): Promise<never> {
          if (stage === 'before') throw new Error('injected crash before credential write');
          await super.applyForVault(input);
          throw new Error('injected crash after credential write');
        }
      }
      fake.live.credentials = new CrashingStore(configDir);
      const registry = new ModelRegistry(fake.live.models, FAKE_PROFILES, {
        credentials: fake.live.credentials,
        getDeviceId: () => 'fixture',
      });
      const adapter = providersVaultAdapter({ workspace, registry, live: fake.live });
      const before = await adapter.capture({ purpose: 'rollback' });
      const draft = await adapter.preview(
        {
          modelProfiles: [{ id: 'model-a', provider: 'openai', model: 'gpt-test-b' }],
          modelProviders: [],
          secrets: { openai: { type: 'api_key', key: 'fixture-new-api-key', origin: null } },
        },
        {},
      );
      await expect(adapter.apply(draft.value, before.revision, 'vault-forward')).rejects.toThrow(
        'injected crash',
      );
      // Reconstruct the owner from persisted files, as after a process restart.
      fake.live.credentials = new FileCredentialStore(configDir);
      const reopened = providersVaultAdapter({ workspace, registry, live: fake.live });
      const receipt = await reopened.receipt?.('vault-forward');
      expect(receipt?.state).toBe(stage === 'before' ? 'partial' : 'complete');
      expect(receipt?.revision).toBe((await reopened.capture()).revision);
      if (!receipt) throw new Error();
      const restored = await reopened.restore(before, receipt.revision, 'vault-rollback');
      expect(readWorkspaceConfig(workspace.root).config.modelProfiles).toEqual(FAKE_PROFILES);
      expect(await fake.live.credentials.read('openai')).toBeUndefined();
      const again = providersVaultAdapter({ workspace, registry, live: fake.live });
      expect(await again.receipt?.('vault-rollback')).toMatchObject({
        state: 'complete',
        revision: restored.revision,
      });
      expect(await again.restore(before, receipt.revision, 'vault-rollback')).toEqual(restored);
    },
  );
});
