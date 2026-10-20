import { ImageGenerationProfile } from '@corral/contracts';

export interface ImageProfilesView {
  profiles: ImageGenerationProfile[];
  statuses?: Record<string, { available: boolean; reason?: string }>;
}
async function request(path = '', method = 'GET', body?: ImageGenerationProfile) {
  const headers = new Headers({ accept: 'application/json' });
  if (method !== 'GET') {
    const session = await fetch('/api/v1/session', { credentials: 'same-origin' });
    if (!session.ok) throw new Error('Open this server’s sign-in link again.');
    const { csrfToken } = (await session.json()) as { csrfToken?: string };
    if (!csrfToken) throw new Error('The server session has expired.');
    headers.set('x-corral-csrf', csrfToken);
    if (body !== undefined) headers.set('content-type', 'application/json');
  }
  const response = await fetch(`/api/v1/image-profiles${path}`, {
    method,
    credentials: 'same-origin',
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const value = await response.json().catch(() => null);
    throw new Error(value?.error?.message ?? 'The image profile request failed.');
  }
  return response.status === 204 ? undefined : response.json();
}
export const imageProfilesApi = {
  list: async (): Promise<ImageProfilesView> => {
    const value = await request();
    return { ...value, profiles: ImageGenerationProfile.array().parse(value.profiles) };
  },
  save: (profile: ImageGenerationProfile) =>
    request(
      `/${encodeURIComponent(profile.profileId)}`,
      'PUT',
      ImageGenerationProfile.parse(profile),
    ),
  remove: (profileId: string) => request(`/${encodeURIComponent(profileId)}`, 'DELETE'),
};
