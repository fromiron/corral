import type {
  EndpointCheckKind,
  ModelConfig,
  ModelProfileView,
  ProviderAuthView,
} from '@corral/client';
import { profileReady } from '../workbench/modelReadiness.ts';

/**
 * A model this connection can call now, by the pickers' rule: known, signed in or keyed, and one
 * a subscription sign-in may use; a named profile also needs its key.
 */
export const modelReady = (view: ModelProfileView) =>
  profileReady(view) && (view.source !== 'profile' || view.keyConfigured);

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

/**
 * Whether Add connection offers a provider. Pi's legacy Codex subscription reaches the models
 * OpenAI's own subscription offers, so it is listed only while a login or a profile uses it.
 */
export function offeredToAdd(
  providerId: string,
  providers: ProviderAuthView[],
  config: Pick<ModelConfig, 'modelProfiles'> | null,
): boolean {
  if (providerId !== 'openai-codex') return true;
  const own = providers.find((provider) => provider.providerId === providerId);
  return Boolean(
    own?.signedIn ||
      own?.source === 'codex-cli' ||
      config?.modelProfiles.some((profile) => profile.provider === providerId),
  );
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
  /** Confirmed to take images. */
  imageInput: boolean;
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
    if (!modelReady(view)) continue;
    const key = modelKey(view.provider, view.modelId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      provider: view.provider,
      providerName: view.providerName,
      modelId: view.modelId,
      name: view.modelName ?? view.modelId,
      imageInput: view.imageInput === true,
    });
  }
  return out.sort(
    (a, b) =>
      a.providerName.localeCompare(b.providerName, undefined, { sensitivity: 'base' }) ||
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  );
}

const HASH_LENGTH = 8;

// SHA-256 of UTF-8, in the page, so an image profile id can follow each keystroke. The first 8 hex
// characters match the model-reference id (server connectionProfileId) for strings that are not
// already Identifiers.

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

function sha256Hex(text: string): string {
  const data = new TextEncoder().encode(text);
  const pad = (64 - ((data.length + 9) % 64)) % 64;
  const bytes = new Uint8Array(data.length + 1 + pad + 8);
  bytes.set(data);
  bytes[data.length] = 0x80;
  const view = new DataView(bytes.buffer);
  const bitLen = data.length * 8;
  view.setUint32(bytes.length - 8, Math.floor(bitLen / 2 ** 32), false);
  view.setUint32(bytes.length - 4, bitLen >>> 0, false);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] ?? 0;
      const w2 = w[i - 2] ?? 0;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) | 0;
    }
    let a = h[0] ?? 0;
    let b = h[1] ?? 0;
    let c = h[2] ?? 0;
    let d = h[3] ?? 0;
    let e = h[4] ?? 0;
    let f = h[5] ?? 0;
    let g = h[6] ?? 0;
    let hh = h[7] ?? 0;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = ((h[0] ?? 0) + a) | 0;
    h[1] = ((h[1] ?? 0) + b) | 0;
    h[2] = ((h[2] ?? 0) + c) | 0;
    h[3] = ((h[3] ?? 0) + d) | 0;
    h[4] = ((h[4] ?? 0) + e) | 0;
    h[5] = ((h[5] ?? 0) + f) | 0;
    h[6] = ((h[6] ?? 0) + g) | 0;
    h[7] = ((h[7] ?? 0) + hh) | 0;
  }
  return [...h].map((word) => (word >>> 0).toString(16).padStart(8, '0')).join('');
}

/**
 * A new image profile's id: the model-reference rule on `<connection>:<image model>`, numbered
 * when a saved profile already has that id. Same inputs and the same taken set always agree.
 */
export function imageProfileIdFor(
  modelProfileId: string,
  modelId: string,
  taken: Iterable<string>,
): string {
  const plain = `${modelProfileId}:${modelId}`;
  let base = plain;
  if (!isIdentifier(plain)) {
    const hash = sha256Hex(plain).slice(0, HASH_LENGTH);
    base = plain.replace(/[^A-Za-z0-9_.:-]/g, '_');
    if (!/^[A-Za-z]/.test(base)) base = `m${base}`;
    base = `${base.slice(0, MAX - HASH_LENGTH - 1)}.${hash}`;
  }
  return uniqueName(base, taken);
}
