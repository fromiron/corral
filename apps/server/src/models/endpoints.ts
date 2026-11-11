import {
  ENDPOINT_DEFAULTS,
  type EndpointSpec,
  endpointProvider,
  KEYLESS_PLACEHOLDER,
  knownEndpointModel,
} from '@corral/adapter-pi';
import type { ModelProviderConfig } from '@corral/core';
import type { ApiKeyAuth, MutableModels } from '@earendil-works/pi-ai';
import type { EndpointModelSource, ModelValues } from './endpoint-models.ts';

// OpenAI-compatible endpoints from `.corral/config.json`. A key entered for one is
// stored with the origin it was entered for, and used only while the workspace still names
// that origin: a workspace file cannot redirect a stored key to another host.

/** Where a stored endpoint key records its origin (inside the credential, never shown). */
export const ENDPOINT_ORIGIN = 'CORRAL_ENDPOINT_ORIGIN';

/** Where one value of an endpoint model came from, highest first. */
export type ValueSource = 'config' | 'known' | 'response' | 'catalog' | 'default';
export type ModelValueField = 'contextWindow' | 'maxOutput' | 'reasoning' | 'imageInput';

export interface Endpoint {
  providerId: string;
  spec: EndpointSpec;
  origin: string;
  /** host[:port] for display; no path, no key. */
  host: string;
  /** Only user-specified values, before endpoint defaults are filled in. */
  contextWindows?: ReadonlyMap<string, number>;
  /** The configuration entry this endpoint was built from; the same object until it is saved again. */
  config?: ModelProviderConfig;
  /** Each model's values and where they came from. */
  sources?: ReadonlyMap<string, Record<ModelValueField, ValueSource>>;
  /** When the list in use was fetched from `/models`, if one is. */
  fetchedAt?: string;
}

const DEFAULT_VALUES: Required<ModelValues> = {
  ...ENDPOINT_DEFAULTS,
  reasoning: false,
  imageInput: false,
};
const FIELDS: readonly ModelValueField[] = [
  'contextWindow',
  'maxOutput',
  'reasoning',
  'imageInput',
];

/**
 * The endpoints of a configuration. Each lists the models of its last `/models` fetch from the
 * same address, plus the models the configuration writes; a written entry wins for its id.
 * Values: configuration, known address/model defaults, `/models`, models.dev, defaults.
 */
export function endpointsFrom(
  configs: readonly ModelProviderConfig[] = [],
  fetched?: EndpointModelSource,
): Map<string, Endpoint> {
  return new Map(
    configs.map((config) => {
      const url = new URL(config.baseUrl);
      const cached = fetched?.read(config.baseUrl) ?? null;
      const written = config.models ?? [];
      const ids = [
        ...new Set([...(cached?.models ?? []).map((m) => m.id), ...written.map((m) => m.id)]),
      ];
      const sources = new Map<string, Record<ModelValueField, ValueSource>>();
      const models = ids.map((id) => {
        const entry = written.find((m) => m.id === id);
        const listed = cached?.models.find((m) => m.id === id);
        const layers: [ValueSource, ModelValues][] = [
          ['config', entry ?? {}],
          ['known', knownEndpointModel(config.baseUrl, id) ?? {}],
          ['response', listed?.response ?? {}],
          ['catalog', listed?.catalog ?? {}],
          ['default', DEFAULT_VALUES],
        ];
        const pick = <K extends ModelValueField>(field: K) => {
          const [source, values] = layers.find(([, values]) => values[field] !== undefined)!;
          return { source, value: values[field] as Required<ModelValues>[K] };
        };
        const picked = Object.fromEntries(FIELDS.map((field) => [field, pick(field)])) as {
          [K in ModelValueField]: { source: ValueSource; value: Required<ModelValues>[K] };
        };
        sources.set(
          id,
          Object.fromEntries(FIELDS.map((field) => [field, picked[field].source])) as Record<
            ModelValueField,
            ValueSource
          >,
        );
        return {
          id,
          ...(entry?.name ? { name: entry.name } : {}),
          contextWindow: picked.contextWindow.value,
          maxOutput: picked.maxOutput.value,
          reasoning: picked.reasoning.value,
          // Text-only unless some source says otherwise, as before lists were fetched.
          ...(picked.imageInput.source !== 'default'
            ? { imageInput: picked.imageInput.value }
            : {}),
        };
      });
      const spec: EndpointSpec = {
        name: config.name,
        baseUrl: config.baseUrl,
        keyless: config.access === 'none',
        ...(config.cacheRetention ? { cacheRetention: config.cacheRetention } : {}),
        ...(config.sessionAffinity ? { sessionAffinity: config.sessionAffinity } : {}),
        models,
      };
      return [
        config.id,
        {
          providerId: config.id,
          spec,
          origin: url.origin,
          host: url.host,
          contextWindows: new Map(
            written.flatMap((model) =>
              model.contextWindow === undefined ? [] : [[model.id, model.contextWindow]],
            ),
          ),
          config,
          sources,
          ...(cached ? { fetchedAt: cached.fetchedAt } : {}),
        },
      ];
    }),
  );
}

/**
 * The definition of one model of an endpoint: what a Run's endpoint hash covers and what its
 * worker receives. Other models of the same endpoint are not part of it.
 */
export function endpointModelSpec(spec: EndpointSpec, modelId: string): EndpointSpec | null {
  const model = spec.models.find((candidate) => candidate.id === modelId);
  return model ? { ...spec, models: [model] } : null;
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

/** Provider ids registered as endpoints in these models, including ones no longer configured. */
export function registeredEndpointIds(models: object): ReadonlySet<string> {
  return registered.get(models as MutableModels) ?? new Set();
}

/** Endpoints that would take the name of a provider pi-ai has. */
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
