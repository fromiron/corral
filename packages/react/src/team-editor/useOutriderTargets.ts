import type { CorralDefinition, HarnessPreviewRole } from '@corral/contracts';
import { sharedOutriderTargets } from '@corral/core';
import { useEffect, useMemo, useState } from 'react';

export type ReadHarnessAsk = (role: HarnessPreviewRole) => Promise<boolean | undefined>;

/** Preview each distinct policy and role selection, including those in saved reference teams. */
export function useOutriderTargets(
  definition: CorralDefinition,
  enabled: boolean,
  resolve: Parameters<typeof sharedOutriderTargets>[1],
  read: ReadHarnessAsk | undefined,
) {
  const scope = useMemo(
    () => ({
      read: enabled ? read : undefined,
      pending: new Map<string, Promise<boolean | undefined>>(),
    }),
    [enabled, read],
  );
  const [checked, setChecked] = useState<{
    scope: typeof scope;
    permissions: ReadonlyMap<string, boolean>;
  }>();
  const { rows, missing } = useMemo(() => {
    const missing = new Map<string, HarnessPreviewRole>();
    const rows = enabled
      ? sharedOutriderTargets(definition, resolve, (role) => {
          const { harness, skills, mcpTools } = role;
          const key = JSON.stringify([
            harness?.profileId,
            harness?.revision,
            skills && [...new Set(skills.map((s) => `${s.resourceHash}:${s.entry}`))].sort(),
            mcpTools &&
              [...new Set(mcpTools.map((tool) => `${tool.serverId}:${tool.name}`))].sort(),
          ]);
          const allowed = checked?.scope === scope ? checked.permissions.get(key) : undefined;
          if (allowed === undefined && !missing.has(key)) missing.set(key, role);
          return allowed;
        })
      : [];
    return { rows, missing };
  }, [definition, enabled, resolve, scope, checked]);

  useEffect(() => () => scope.pending.clear(), [scope]);
  useEffect(() => {
    if (!scope.read) return;
    const { pending } = scope;
    for (const key of pending.keys()) {
      if (!missing.has(key)) pending.delete(key);
    }
    for (const [key, role] of missing) {
      if (pending.has(key)) continue;
      const preview = scope.read(role);
      pending.set(key, preview);
      void preview.then(
        (allowed) => {
          if (allowed === undefined || pending.get(key) !== preview) return;
          setChecked((previous) => ({
            scope,
            permissions: new Map(previous?.scope === scope ? previous.permissions : []).set(
              key,
              allowed,
            ),
          }));
        },
        // A preview problem or transport failure leaves permission unconfirmed.
        () => {},
      );
    }
  }, [missing, scope]);
  return rows;
}
