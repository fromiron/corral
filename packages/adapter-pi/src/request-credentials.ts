import type { Credential, CredentialStore } from '@earendil-works/pi-ai';

// CR-004: pi-ai applies a per-request API key only to providers with API-key auth. An OAuth-only
// provider (`openai-codex`, which a Codex CLI login signs in to) reads its credential from a
// store instead. The worker has no credential store (ADR-019), so this one holds just the token
// that came with the current request, in memory, and never refreshes it: the host does that.

const VALID_MS = 60 * 60 * 1000;

export function requestCredentials(): {
  store: CredentialStore;
  /** The token for the provider's next request. */
  use(providerId: string, token: string): void;
} {
  const tokens = new Map<string, string>();
  const read = async (providerId: string): Promise<Credential | undefined> => {
    const token = tokens.get(providerId);
    // Far enough ahead that pi-ai never tries to refresh it here.
    return token === undefined
      ? undefined
      : { type: 'oauth', access: token, refresh: '', expires: Date.now() + VALID_MS };
  };
  return {
    store: {
      read,
      list: async () => [...tokens.keys()].map((providerId) => ({ providerId, type: 'oauth' })),
      modify: (providerId) => read(providerId),
      delete: async (providerId) => {
        tokens.delete(providerId);
      },
    },
    use(providerId, token) {
      tokens.set(providerId, token);
    },
  };
}
