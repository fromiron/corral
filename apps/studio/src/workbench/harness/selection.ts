import type { HarnessEntryKey, HarnessProfile } from '@corral/contracts';

const keyOf = (ref: HarnessEntryKey) => `${ref.resourceHash}:${ref.entry}`;
export function updateResourceSelection(
  profile: HarnessProfile,
  key: HarnessEntryKey,
  use: boolean,
  replacing: HarnessProfile['resources'] = [],
  mode?: 'auto' | 'explicit' | 'mandatory',
): HarnessProfile {
  const selected = profile.resources.find((ref) => keyOf(ref) === keyOf(key));
  const removed = new Set([keyOf(key), ...replacing.map(keyOf)]);
  return {
    ...profile,
    resources: [
      ...profile.resources.filter((ref) => !removed.has(keyOf(ref))),
      ...(use
        ? [
            {
              ...key,
              required:
                selected?.required ??
                (replacing.length ? replacing.some((ref) => ref.required) : true),
              ...(key.kind === 'skill'
                ? { skillMode: mode ?? selected?.skillMode ?? replacing[0]?.skillMode ?? 'auto' }
                : {}),
            },
          ]
        : []),
    ],
  };
}
