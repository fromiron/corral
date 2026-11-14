import type { ComponentProps } from 'react';
import { type SessionConnection, SessionConnectionContext } from './SessionConnection.tsx';
import { WorkTab } from './WorkTab.tsx';

/**
 * The session page's conversation view: the conversation with the page's link to the server.
 * A lost link is told by the composer's activity bar, not by a banner above the timeline.
 */
export function SessionChat({
  connection,
  ...work
}: { connection: SessionConnection } & ComponentProps<typeof WorkTab>) {
  return (
    <SessionConnectionContext.Provider value={connection}>
      <div className="flex h-full min-h-0 flex-col">
        <WorkTab {...work} />
      </div>
    </SessionConnectionContext.Provider>
  );
}
