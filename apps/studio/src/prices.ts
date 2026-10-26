import type { ModelPrice, ModelPrices } from '@corral/react';
import { useEffect, useMemo, useState } from 'react';
import { useServices } from './services.tsx';

/**
 * List prices from the local server's model catalog, for the run cost estimate.
 * Undefined in the in-browser runtime: its agents are simulated and cost nothing.
 */
export function useModelPrices(): ModelPrices | undefined {
  const { models } = useServices();
  const [table, setTable] = useState<Map<string, ModelPrice> | null>(null);
  useEffect(() => {
    if (!models) return;
    let active = true;
    models
      .catalog()
      .then((catalog) => {
        if (!active) return;
        setTable(
          new Map(
            catalog.flatMap((provider) =>
              provider.endpoint
                ? []
                : provider.models.map((m) => [`${provider.providerId}/${m.id}`, m.cost] as const),
            ),
          ),
        );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [models]);
  return useMemo(
    () =>
      table
        ? (provider: string, modelId: string) => table.get(`${provider}/${modelId}`) ?? null
        : undefined,
    [table],
  );
}
