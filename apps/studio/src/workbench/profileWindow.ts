import type { ModelConfig } from '@corral/client';

export function withProfileWindow(
  config: ModelConfig,
  profileId: string,
  contextWindow: number | null,
): Pick<ModelConfig, 'modelProfiles' | 'modelProviders' | 'revision'> {
  return {
    revision: config.revision,
    modelProfiles: config.modelProfiles.map((profile) => {
      if (profile.id !== profileId) return profile;
      const { contextWindow: _before, ...rest } = profile;
      return contextWindow === null ? rest : { ...rest, contextWindow };
    }),
    modelProviders: config.modelProviders,
  };
}
