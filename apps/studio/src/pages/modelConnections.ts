import type { EndpointCheckKind, ModelProfileView, ProviderAuthView } from '@corral/client';

/** How a connected provider signs in, as its row names it. */
export type ConnectionMethod = 'subscription' | 'oauth' | 'apiKey' | 'envKey' | 'codex' | 'keyless';
/** Why a row needs the person. */
export type ConnectionCause =
  | 'notConnected'
  | 'signingIn'
  | 'signInFailed'
  | 'addressChanged'
  | 'permissions'
  | `fetch.${Exclude<EndpointCheckKind, 'connected'>}`;
/** The one thing the person does about it. */
export type ConnectionAction =
  | 'connect'
  | 'signInAgain'
  | 'enterKeyAgain'
  | 'retry'
  | 'editAddress';

export type ConnectionState =
  | { kind: 'connected'; method: ConnectionMethod; count: number }
  | {
      kind: 'action';
      status: 'needs-auth' | 'connecting' | 'error';
      cause: ConnectionCause;
      action: ConnectionAction | null;
    };

/**
 * The one line a connection row shows: how it is connected and how many models it gives, or the
 * one thing the person must do. A token's expiry is not here: nothing is to be done about it.
 */
export function connectionState(provider: ProviderAuthView): ConnectionState {
  const login = provider.login;
  if (login?.state === 'failed')
    return { kind: 'action', status: 'error', cause: 'signInFailed', action: 'signInAgain' };
  if (login) return { kind: 'action', status: 'connecting', cause: 'signingIn', action: null };
  if (provider.endpoint && provider.endpointChanged)
    return {
      kind: 'action',
      status: 'needs-auth',
      cause: 'addressChanged',
      action: 'enterKeyAgain',
    };
  if (!provider.signedIn || !provider.method)
    return { kind: 'action', status: 'needs-auth', cause: 'notConnected', action: 'connect' };
  const fetched = provider.endpoint ? provider.modelFetch?.kind : undefined;
  if (fetched && fetched !== 'connected')
    return {
      kind: 'action',
      status: 'error',
      cause: `fetch.${fetched}`,
      action:
        fetched === 'authentication'
          ? provider.methods.apiKey
            ? 'enterKeyAgain'
            : 'editAddress'
          : fetched === 'redirect' || fetched === 'unsupported'
            ? 'editAddress'
            : 'retry',
    };
  if (provider.source === 'codex-cli' && !provider.permissionsOk)
    return { kind: 'action', status: 'error', cause: 'permissions', action: null };
  return { kind: 'connected', method: methodOf(provider), count: provider.modelCount };
}

function methodOf(provider: ProviderAuthView): ConnectionMethod {
  if (provider.method === 'none') return 'keyless';
  if (provider.source === 'codex-cli') return 'codex';
  if (provider.method === 'api_key') return provider.source === 'environment' ? 'envKey' : 'apiKey';
  return provider.subscription ? 'subscription' : 'oauth';
}

/** Rows that need the person first, then the connected ones; alphabetical inside each. */
export function sortConnections(providers: ProviderAuthView[]): ProviderAuthView[] {
  const rank = (provider: ProviderAuthView) =>
    connectionState(provider).kind === 'action' ? 0 : 1;
  return [...providers].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
      a.providerId.localeCompare(b.providerId),
  );
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/;
const MAX = 120;

/** Text made into an Identifier: other characters become `-`, and it starts with a letter. */
export function identifierFrom(text: string, prefix: string): string {
  let id = text
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!id) return prefix;
  if (!/^[A-Za-z]/.test(id)) id = `${prefix}-${id}`;
  return id.slice(0, MAX);
}

export const isIdentifier = (text: string) => IDENTIFIER.test(text);

/** `base`, or `base-2`, `base-3`… when taken, kept within the Identifier length. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const name = `${base.slice(0, MAX - suffix.length)}${suffix}`;
    if (!used.has(name)) return name;
  }
}

/** A new profile's name: its model id as an Identifier, numbered when another profile has it. */
export const profileNameFor = (modelId: string, taken: Iterable<string>) =>
  uniqueName(identifierFrom(modelId, 'model'), taken);

/** An added address's id: its name in lower case, unused by any provider. */
export const endpointIdFor = (name: string, taken: Iterable<string>) =>
  uniqueName(identifierFrom(name.toLowerCase(), 'endpoint'), taken);

/** A connected model to choose for a profile: one per provider and model. */
export interface ConnectedModel {
  key: string;
  provider: string;
  providerName: string;
  modelId: string;
  name: string;
}

export const modelKey = (provider: string, modelId: string) => `${provider}\u0000${modelId}`;

/**
 * The models a profile can point at: every connected provider's models, including the ones a
 * named profile already points at (the server lists those under the profile only).
 */
export function connectedModels(profiles: ModelProfileView[]): ConnectedModel[] {
  const seen = new Set<string>();
  const out: ConnectedModel[] = [];
  for (const view of profiles) {
    if (view.source === 'profile' && !(view.available && view.keyConfigured)) continue;
    const key = modelKey(view.provider, view.modelId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      provider: view.provider,
      providerName: view.providerName,
      modelId: view.modelId,
      name: view.modelName ?? view.modelId,
    });
  }
  return out.sort(
    (a, b) =>
      a.providerName.localeCompare(b.providerName, undefined, { sensitivity: 'base' }) ||
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  );
}
