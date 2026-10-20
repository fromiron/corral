import { createHash } from 'node:crypto';
import { canonicalJson, ImageGenerationProfile } from '@corral/contracts';
import type { Db } from '@corral/storage-sqlite';
import type { ModelRegistry } from '../models/registry.ts';
import type { ResolvedImageProfile } from './service.ts';

export class ImageProfileStore {
  private readonly db: Db;
  private readonly registry: () => ModelRegistry | null;
  constructor(db: Db, registry: () => ModelRegistry | null) {
    this.db = db;
    this.registry = registry;
  }
  list(): ImageGenerationProfile[] {
    return (
      this.db
        .prepare('SELECT config_json FROM image_generation_profiles ORDER BY profile_id')
        .all() as { config_json: string }[]
    ).map((row) => ImageGenerationProfile.parse(JSON.parse(row.config_json)));
  }
  put(raw: unknown): ImageGenerationProfile {
    const profile = ImageGenerationProfile.omit({ bindingHash: true }).parse(raw);
    this.db
      .prepare(
        'INSERT INTO image_generation_profiles VALUES (?,?) ON CONFLICT(profile_id) DO UPDATE SET config_json=excluded.config_json',
      )
      .run(profile.profileId, canonicalJson(profile));
    return profile;
  }
  remove(profileId: string): void {
    this.db.prepare('DELETE FROM image_generation_profiles WHERE profile_id=?').run(profileId);
  }
  resolve(profileId: string): ResolvedImageProfile | null {
    const profile = this.list().find((candidate) => candidate.profileId === profileId);
    const registry = this.registry();
    if (!profile || !registry) return null;
    const model = registry.resolve(profile.modelProfileId, 'live');
    if (!model.ok || model.snapshot.auth !== 'api_key') return null;
    const endpoint = registry.endpointOf(model.snapshot);
    if (!endpoint && model.snapshot.provider !== 'openai') return null;
    const baseUrl = endpoint?.baseUrl ?? 'https://api.openai.com/v1';
    if (endpoint?.keyless) return null;
    const bindingHash = createHash('sha256')
      .update(canonicalJson({ snapshot: model.snapshot, baseUrl }))
      .digest('hex');
    return {
      profile: { ...profile, bindingHash },
      baseUrl,
      apiKey: async () => (await registry.credentials(model.snapshot)) ?? undefined,
    };
  }
}
