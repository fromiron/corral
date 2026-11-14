import { createContext, type ReactNode, useContext, useState } from 'react';

// Advice its target never read leaves Needs you once its words are on screen (features/inbox.md
// `advice`, features/advisor.md 보이는 곳): the server is told the execution row was opened. Going
// to it is not seeing it, so only a shown advice's text tells.

/** Tells the server that an execution's advice was seen. */
export type AdviceSeenSend = (runId: string, executionId: string) => Promise<void>;

export interface AdviceSeen {
  /**
   * These advice are on screen in full. Each is told once; one whose telling failed is told again
   * the next time it is shown.
   */
  seen(runId: string, items: readonly { adviceId: string; targetExecutionId: string }[]): void;
}

export function createAdviceSeen(send: AdviceSeenSend): AdviceSeen {
  const told = new Set<string>();
  const telling = new Set<string>();
  const key = (runId: string, adviceId: string) => JSON.stringify([runId, adviceId]);
  return {
    seen(runId, items) {
      const waiting = new Map<string, string[]>();
      for (const item of items) {
        const id = key(runId, item.adviceId);
        if (told.has(id) || telling.has(id)) continue;
        telling.add(id);
        waiting.set(item.targetExecutionId, [...(waiting.get(item.targetExecutionId) ?? []), id]);
      }
      // The server knows an execution row, not an advice: one telling covers its advice.
      for (const [executionId, ids] of waiting)
        void send(runId, executionId)
          .then(
            () => {
              for (const id of ids) told.add(id);
            },
            () => {},
          )
          .finally(() => {
            for (const id of ids) telling.delete(id);
          });
    },
  };
}

const AdviceSeenContext = createContext<AdviceSeen | null>(null);

/** One telling for the whole app, so a row mounted again does not tell again. */
export function AdviceSeenProvider({
  send,
  children,
}: {
  send: AdviceSeenSend | null | undefined;
  children: ReactNode;
}) {
  const [seen] = useState(() => (send ? createAdviceSeen(send) : null));
  return <AdviceSeenContext.Provider value={seen}>{children}</AdviceSeenContext.Provider>;
}

export const useAdviceSeen = () => useContext(AdviceSeenContext);
