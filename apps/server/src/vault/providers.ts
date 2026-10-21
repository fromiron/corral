import { parseWorkspaceConfig } from '@corral/core';
import type { Credential } from '@earendil-works/pi-ai';
import { z } from 'zod';
import type { LiveModels } from '../app.ts';
import type { VaultCredentialOwner } from '../models/credential-store.ts';
import { endpointClashes, endpointsFrom, registerEndpoints } from '../models/endpoints.ts';
import type { ModelRegistry } from '../models/registry.ts';
import { readWorkspaceConfig, type Workspace, writeModelConfig } from '../workspace.ts';
import { vaultRevision } from './service.ts';
import type { VaultDomainAdapter } from './types.ts';

const wire = z.strictObject({
  modelProfiles: z.array(z.unknown()).max(20),
  modelProviders: z.array(z.unknown()).max(10),
  secrets: z
    .record(
      z.string(),
      z.strictObject({
        type: z.literal('api_key'),
        key: z.string().min(1).max(8192),
        origin: z.string().nullable(),
      }),
    )
    .optional(),
});
export function providersVaultAdapter(options: {
  workspace: Workspace;
  registry: ModelRegistry;
  live: LiveModels;
}): VaultDomainAdapter {
  const { workspace, registry, live } = options;
  const owner = live.credentials as typeof live.credentials & Partial<VaultCredentialOwner>;
  function credentialOwner(): VaultCredentialOwner {
    if (
      !owner.readOwnForVault ||
      !owner.applyForVault ||
      !owner.receiptForVault ||
      !owner.fingerprintForVault
    )
      throw new Error('This credential store does not support recoverable vault operations.');
    return owner as typeof live.credentials & VaultCredentialOwner;
  }
  async function current() {
    const snapshot = readWorkspaceConfig(workspace.root);
    const modelProfiles = snapshot.config.modelProfiles ?? [...registry.profileConfigs()];
    const modelProviders = snapshot.config.modelProviders ?? [];
    const credentials = await credentialOwner().readOwnForVault();
    return {
      revision: await credentialOwner().fingerprintForVault({
        modelProfiles,
        modelProviders,
        credentials,
      }),
      configRevision: snapshot.revision,
      modelProfiles,
      modelProviders,
      credentials,
      operation: snapshot.config.modelSettingsOperation,
    };
  }
  async function receipt(operationId: string) {
    const stored = await credentialOwner().receiptForVault(operationId);
    if (stored) return { revision: stored.revision, state: 'complete' as const };
    const state = await current();
    const marker = state.operation;
    if (!marker || marker.id !== operationId) return null;
    const modelHash = vaultRevision({
      modelProfiles: state.modelProfiles,
      modelProviders: state.modelProviders,
    });
    if (
      modelHash !== marker.modelHash ||
      (await credentialOwner().fingerprintForVault(state.credentials)) !== marker.beforeHash
    )
      return null;
    return { revision: state.revision, state: 'partial' as const };
  }
  async function update(
    raw: unknown,
    expectedRevision: string,
    operationId: string,
    rollback = false,
  ) {
    const before = await current();
    const data = raw as {
      modelProfiles: unknown[];
      modelProviders: unknown[];
      secrets?: z.infer<typeof wire>['secrets'];
      localCredentials?: Record<string, Credential>;
    };
    const parsed = parseWorkspaceConfig({
      schemaVersion: '0.1',
      modelProfiles: data.modelProfiles,
      modelProviders: data.modelProviders,
    });
    if (!parsed.ok) throw new Error('Invalid provider settings.');
    const target = {
      modelProfiles: parsed.config.modelProfiles ?? [],
      modelProviders: parsed.config.modelProviders ?? [],
    };
    const endpoints = endpointsFrom(target.modelProviders);
    const desired = structuredClone(
      rollback && data.localCredentials ? data.localCredentials : before.credentials,
    );
    if (!rollback)
      for (const [provider, secret] of Object.entries(data.secrets ?? {})) {
        const endpoint = endpoints.get(provider);
        if ((endpoint?.origin ?? null) !== secret.origin || endpoint?.spec.keyless)
          throw new Error('Credential endpoint binding changed.');
        desired[provider] = {
          type: 'api_key',
          key: secret.key,
          ...(secret.origin ? { env: { CORRAL_ENDPOINT_ORIGIN: secret.origin } } : {}),
        };
      }
    const requestHash = await credentialOwner().fingerprintForVault({ target, desired, rollback });
    const recorded = await credentialOwner().receiptForVault(operationId);
    if (recorded) {
      if (recorded.requestHash !== requestHash)
        throw new Error('Provider operation identity changed.');
      return { revision: recorded.revision };
    }
    const existing = before.operation?.id === operationId ? before.operation : null;
    if (existing && existing.requestHash !== requestHash)
      throw new Error('Provider operation identity changed.');
    if (before.revision !== expectedRevision)
      throw new Error('Provider settings changed since preview.');
    const marker = existing ?? {
      id: operationId,
      requestHash,
      modelHash: vaultRevision(target),
      beforeHash: await credentialOwner().fingerprintForVault(before.credentials),
      afterHash: await credentialOwner().fingerprintForVault(desired),
      resultRevision: await credentialOwner().fingerprintForVault({
        ...target,
        credentials: desired,
      }),
    };
    if (!existing) {
      const written = writeModelConfig(
        workspace.root,
        target,
        before.configRevision,
        (config) => {
          const endpoints = endpointsFrom(config.modelProviders);
          return [
            ...endpointClashes(live.models, endpoints),
            ...registry.unknownProviders(config.modelProfiles ?? [], endpoints),
          ];
        },
        marker,
      );
      if (!written.ok) throw new Error('Provider settings changed or are not supported.');
      workspace.config = written.config;
      workspace.configRevision = written.revision;
    } else if ((await receipt(operationId))?.state !== 'partial') {
      throw new Error('Provider operation has an unrecognized checkpoint.');
    }
    // The credential owner commits all changes and its receipt in one file replacement.
    // Its final check runs after queued credential writes, before the synchronous commit.
    const committed = await credentialOwner().applyForVault({
      operationId,
      requestHash,
      expectedHash: marker.beforeHash,
      revision: marker.resultRevision,
      credentials: desired,
      canCommit() {
        const latest = readWorkspaceConfig(workspace.root);
        return (
          latest.config.modelSettingsOperation?.id === operationId &&
          latest.config.modelSettingsOperation.requestHash === requestHash &&
          vaultRevision({
            modelProfiles: latest.config.modelProfiles ?? [],
            modelProviders: latest.config.modelProviders ?? [],
          }) === marker.modelHash
        );
      },
    });
    const latest = readWorkspaceConfig(workspace.root);
    workspace.config = latest.config;
    workspace.configRevision = latest.revision;
    const activeEndpoints = endpointsFrom(latest.config.modelProviders);
    registerEndpoints(live.models, activeEndpoints);
    await registry.reconfigure(latest.config.modelProfiles ?? [], activeEndpoints, latest.revision);
    return { revision: committed.revision };
  }
  return {
    async capture(options) {
      const snapshot = await current();
      const value: Record<string, unknown> = {
        modelProfiles: snapshot.modelProfiles,
        modelProviders: snapshot.modelProviders,
      };
      if (options?.purpose === 'rollback') value.localCredentials = snapshot.credentials;
      else if (options?.includeSecrets?.length) {
        const secrets: NonNullable<z.infer<typeof wire>['secrets']> = {};
        for (const provider of options.includeSecrets) {
          const credential = snapshot.credentials[provider];
          if (!snapshot.modelProfiles.some((profile) => profile.provider === provider))
            throw new Error('Choose a credential used by an exported model profile.');
          if (credential?.type !== 'api_key' || !credential.key)
            throw new Error(
              'Only explicitly selected API keys can be exported. OAuth sessions stay on this device.',
            );
          const endpoint = snapshot.modelProviders.find((item) => item.id === provider);
          const origin = endpoint ? new URL(endpoint.baseUrl).origin : null;
          if (origin && credential.env?.CORRAL_ENDPOINT_ORIGIN !== origin)
            throw new Error('Stored credential is bound to a different endpoint.');
          secrets[provider] = { type: 'api_key', key: credential.key, origin };
        }
        value.secrets = secrets;
      }
      return { revision: snapshot.revision, value };
    },
    async preview(raw, bindings) {
      const parsed = wire.safeParse(raw);
      if (!parsed.success)
        throw new Error(
          'Invalid portable provider settings; OAuth/local credential data cannot be imported.',
        );
      const data = structuredClone(parsed.data);
      const checked = parseWorkspaceConfig({
        schemaVersion: '0.1',
        modelProfiles: data.modelProfiles,
        modelProviders: data.modelProviders,
      });
      if (!checked.ok) throw new Error('Provider settings do not match the configuration schema.');
      for (const endpoint of checked.config.modelProviders ?? []) {
        const url = new URL(endpoint.baseUrl);
        if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
          const local = bindings[`endpoint:${endpoint.id}`];
          if (!local)
            throw new Error(`Bind endpoint:${endpoint.id} to this device before importing.`);
          endpoint.baseUrl = local;
        }
      }
      const validated = parseWorkspaceConfig({
        schemaVersion: '0.1',
        modelProfiles: checked.config.modelProfiles,
        modelProviders: checked.config.modelProviders,
      });
      if (!validated.ok) throw new Error('The selected local endpoint binding is invalid.');
      const endpoints = endpointsFrom(validated.config.modelProviders);
      if (
        endpointClashes(live.models, endpoints).length ||
        registry.unknownProviders(validated.config.modelProfiles ?? [], endpoints).length
      )
        throw new Error(
          'An imported provider is unavailable or conflicts with a built-in provider.',
        );
      for (const [provider, secret] of Object.entries(data.secrets ?? {})) {
        if (
          !validated.config.modelProfiles?.some((profile) => profile.provider === provider) ||
          (endpoints.get(provider)?.origin ?? null) !== secret.origin
        )
          throw new Error('A credential is not bound to the selected provider and endpoint.');
      }
      return {
        value: {
          modelProfiles: validated.config.modelProfiles ?? [],
          modelProviders: validated.config.modelProviders ?? [],
          ...(data.secrets ? { secrets: data.secrets } : {}),
        },
        warnings: [
          'Replaces model profiles and endpoint definitions. Existing Runs retain their snapshots.',
          ...(data.secrets && Object.keys(data.secrets).length
            ? [
                'Includes selected API keys; matching provider credentials will be replaced. OAuth sessions are not portable.',
              ]
            : ['Credentials are excluded; configure sign-in on this device.']),
        ],
      };
    },
    apply(value, revision, operationId) {
      return update(value, revision, operationId);
    },
    restore(snapshot, revision, operationId) {
      return update(snapshot.value, revision, operationId, true);
    },
    receipt,
  };
}
