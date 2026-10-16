import {
  ENDPOINT_DEFAULTS,
  type EndpointSpec,
  endpointProvider,
  KEYLESS_PLACEHOLDER,
} from '@corral/adapter-pi';
import type { ModelProviderConfig } from '@corral/core';
import type { ApiKeyAuth, MutableModels } from '@earendil-works/pi-ai';

// CR-005: OpenAI-compatible endpoints from `.corral/config.json`. A key entered for one is
// stored with the origin it was entered for, and used only while the workspace still names
// that origin: a workspace file cannot redirect a stored key to another host.

/** Where a stored endpoint key records its origin (inside the credential, never shown). */
export const ENDPOINT_ORIGIN = 'CORRAL_ENDPOINT_ORIGIN';

export interface Endpoint {
  providerId: string;
  spec: EndpointSpec;
  origin: string;
  /** host[:port] for display; no path, no key. */
  host: string;
}

export function endpointsFrom(configs: readonly ModelProviderConfig[] = []): Map<string, Endpoint> {
  return new Map(
    configs.map((config) => {
      const url = new URL(config.baseUrl);
      const spec: EndpointSpec = {
        name: config.name,
        baseUrl: config.baseUrl,
        keyless: config.access === 'none',
        models: config.models.map((m) => ({
          id: m.id,
          ...(m.name ? { name: m.name } : {}),
          contextWindow: m.contextWindow ?? ENDPOINT_DEFAULTS.contextWindow,
          maxOutput: m.maxOutput ?? ENDPOINT_DEFAULTS.maxOutput,
          reasoning: m.reasoning ?? false,
        })),
      };
      return [config.id, { providerId: config.id, spec, origin: url.origin, host: url.host }];
    }),
  );
}

/** The host's auth for an endpoint: the stored key, only for the origin it was entered for. */
function boundKeyAuth(endpoint: Endpoint): ApiKeyAuth {
  return {
    name: `${endpoint.spec.name} API key`,
    resolve: async ({ credential }) => {
      if (endpoint.spec.keyless) {
        return { auth: { apiKey: KEYLESS_PLACEHOLDER }, source: 'keyless endpoint' };
      }
      return credential?.key && credential.env?.[ENDPOINT_ORIGIN] === endpoint.origin
        ? { auth: { apiKey: credential.key }, source: 'stored credential' }
        : undefined;
    },
  };
}

const registered = new WeakMap<MutableModels, Set<string>>();

/** Endpoints that would take the name of a provider pi-ai has (CR-005, CR-008). */
export function endpointClashes(models: MutableModels, endpoints: ReadonlyMap<string, Endpoint>) {
  const ours = registered.get(models) ?? new Set<string>();
  return [...endpoints.values()].flatMap((endpoint, index) =>
    models.getProvider(endpoint.providerId) && !ours.has(endpoint.providerId)
      ? [
          `modelProviders.${index}.id: "${endpoint.providerId}" is a built-in provider; choose another id`,
        ]
      : [],
  );
}

/** Adds the endpoints as providers; one may not take the name of a provider pi-ai has. */
export function registerEndpoints(models: MutableModels, endpoints: ReadonlyMap<string, Endpoint>) {
  const ours = registered.get(models) ?? new Set<string>();
  registered.set(models, ours);
  [...endpoints.values()].forEach((endpoint, index) => {
    if (models.getProvider(endpoint.providerId) && !ours.has(endpoint.providerId)) {
      throw new Error(
        `modelProviders.${index}.id: "${endpoint.providerId}" is a built-in provider; choose another id`,
      );
    }
    models.setProvider(
      endpointProvider(endpoint.providerId, endpoint.spec, boundKeyAuth(endpoint)),
    );
    ours.add(endpoint.providerId);
  });
}
