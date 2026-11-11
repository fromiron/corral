import type { ModelProfileView } from '@corral/client';

/**
 * Ready to call: the model is known, a sign-in or key is set, and a subscription sign-in may use
 * this model. The sidebar's connection state and Settings › Diagnostics read the same rule.
 */
export function profileReady(profile: ModelProfileView): boolean {
  return (
    profile.available &&
    profile.method !== null &&
    !(profile.method === 'oauth' && profile.subscriptionSupported === false)
  );
}
