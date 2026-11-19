import type { CorralDefinition, HarnessBindingRef } from '@corral/contracts';
import { sharedOutriderTargets } from '@corral/core';
import { useEffect, useMemo, useState } from 'react';

export type ReadHarnessAsk = (binding: HarnessBindingRef) => Promise<boolean>;

/** One preview per pinned work style used by the roster, including inside saved reference teams. */
export function useOutriderTargets(
  definition: CorralDefinition,
  enabled: boolean,
  resolve: Parameters<typeof sharedOutriderTargets>[1],
  read: ReadHarnessAsk | undefined,
) {
  const [checked, setChecked] = useState<{
    read: ReadHarnessAsk;
    permissions: ReadonlyMap<string, boolean>;
  }>();
  const { rows, keys } = useMemo(() => {
    const pins = new Set<string>();
    const rows = enabled
      ? sharedOutriderTargets(definition, resolve, (binding) => {
          const key = `${binding.profileId}@${binding.revision}`;
          pins.add(key);
          return checked && checked.read === read ? checked.permissions.get(key) : undefined;
        })
      : [];
    return { rows, keys: [...pins].sort().join('\n') };
  }, [definition, enabled, resolve, read, checked]);

  useEffect(() => {
    if (!read || !keys) return;
    let active = true;
    const permissions = new Map<string, boolean>();
    for (const key of keys.split('\n')) {
      const [profileId, revision] = key.split('@');
      if (!profileId) continue;
      void read({ profileId, revision: Number(revision) }).then(
        (allowed) => {
          if (!active) return;
          permissions.set(key, allowed);
          setChecked({ read, permissions: new Map(permissions) });
        },
        // A failed preview cannot confirm the permission. Refreshing work styles retries it.
        () => {},
      );
    }
    return () => {
      active = false;
    };
  }, [keys, read]);
  return rows;
}
