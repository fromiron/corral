import { AgentRole } from '@corral/contracts';
import { openDatabase } from '@corral/storage-sqlite';
import { expect, it } from 'vitest';
import { ImageProfileStore } from '../src/images-generation/profiles.ts';
import type { ModelRegistry } from '../src/models/registry.ts';

// A profile saved under an id the screen would not derive, and a role that names that id, still
// resolve. The store does not recompute ids from the connection and the image model.

const legacy = {
  profileId: 'illustration',
  modelProfileId: 'keyed',
  modelId: 'gpt-image-1',
  api: 'openai-images' as const,
  timeoutMs: 120000,
};
const derived = {
  profileId: 'keyed:gpt-image-1',
  modelProfileId: 'keyed',
  modelId: 'gpt-image-1',
  api: 'openai-images' as const,
  timeoutMs: 60000,
};

it('resolves a role by the image profile id that was saved', () => {
  const db = openDatabase(':memory:');
  try {
    const registry = {
      resolve: () => ({ ok: true as const, snapshot: { auth: 'api_key', provider: 'openai' } }),
      endpointOf: () => null,
      credentials: async () => 'test-key',
    } as unknown as ModelRegistry;
    const store = new ImageProfileStore(db, () => registry);
    store.put(legacy);
    store.put(derived);
    const role = AgentRole.parse({
      id: 'writer',
      name: 'Writer',
      prompt: 'Draw the figure.',
      modelProfile: 'text',
      allowedWorkTools: ['generate_image'],
      allowedCollaborationTools: [],
      outputContract: 'text',
      imageProfile: 'illustration',
    });
    expect(role.imageProfile).toBe('illustration');
    if (!role.imageProfile) throw new Error('the role lost its image profile');
    expect(store.resolve(role.imageProfile)?.profile).toMatchObject({
      profileId: 'illustration',
      modelId: 'gpt-image-1',
      timeoutMs: 120000,
    });
    // The same connection and image model can also be a newer, derived id. It does not replace
    // the role that still names the saved one.
    expect(store.resolve('keyed:gpt-image-1')?.profile.timeoutMs).toBe(60000);
    expect(
      store
        .list()
        .map((profile) => profile.profileId)
        .sort(),
    ).toEqual(['illustration', 'keyed:gpt-image-1']);
  } finally {
    db.close();
  }
});
