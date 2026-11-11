import { DesignKitProvider, SizeScope } from '@corral/react/design-kit';
import type { ReactNode } from 'react';
import { usePreferences } from './preferences.ts';

/**
 * The kit root with the person's interface density. The provider takes its size only once, so a
 * controlled kit size scope carries a later change to every component at once.
 */
export function StudioDesignKit({ children }: { children: ReactNode }) {
  const { density } = usePreferences();
  return (
    <DesignKitProvider size={density}>
      <SizeScope size={density}>{children}</SizeScope>
    </DesignKitProvider>
  );
}
