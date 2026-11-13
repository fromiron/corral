import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { pendingInteractions, type RunSummary } from '@corral/core';
import type { RunSessionStore } from '@corral/react';
import { Button } from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslations } from 'use-intl';
import { createStore, type StoreApi, useStore } from 'zustand';
import { useServices } from '../../services.tsx';
import { RunResponseArea } from '../RunResponseArea.tsx';

interface TrayState {
  /** The tray is in the conversation's view: not scrolled away, not behind the composer. */
  visible: boolean;
  /** Requests waiting in the tray, over all of the session's runs. */
  waiting: number;
  /** When a request to bring the tray into view and focus it was made (`respond`); 0 for none. */
  revealAt: number;
}

/** The needed-now tray's state on one session screen. */
export type PendingTrayStore = StoreApi<TrayState>;

export const createPendingTrayStore = (): PendingTrayStore =>
  createStore<TrayState>(() => ({ visible: false, waiting: 0, revealAt: 0 }));

/** A request to reveal the tray counts this long, so a late one does not move focus later. */
const REVEAL_WINDOW_MS = 5_000;

/** Asks the tray to come into view and take focus, once, as soon as it shows what waits. */
export function revealPendingTray(store: PendingTrayStore) {
  store.setState({ revealAt: performance.now() });
}

interface PendingTrayContextValue {
  store: PendingTrayStore;
  /**
   * Takes the person from elsewhere on the session screen (the run record) to the tray: the one
   * place the session's waiting requests are answered.
   */
  respond?: () => void;
}

export const PendingTrayContext = createContext<PendingTrayContextValue | null>(null);

function useTrayStore() {
  const context = useContext(PendingTrayContext);
  const [own] = useState(createPendingTrayStore);
  return context?.store ?? own;
}

/**
 * Whether the conversation's needed-now tray is on screen, and how many requests wait in it: what
 * the activity bar needs to tell a waiting request only while its card is out of view.
 */
export function usePendingTray(): { visible: boolean; waiting: number } {
  const store = useTrayStore();
  const visible = useStore(store, (state) => state.visible);
  const waiting = useStore(store, (state) => state.waiting);
  return { visible, waiting };
}

/** The way to the conversation's tray, on a session screen whose conversation answers requests. */
export function useRespondInConversation(): (() => void) | null {
  return useContext(PendingTrayContext)?.respond ?? null;
}

/** Each run's waiting count, `runId:count` joined; empty while nothing waits. */
function waitingOf(stores: readonly (readonly [string, RunSessionStore])[]) {
  return stores
    .flatMap(([runId, store]) => {
      const { events, projection } = store.getState();
      const count =
        projection?.runId === runId ? pendingInteractions(events, projection).length : 0;
      return count ? [`${runId}:${count}`] : [];
    })
    .join(',');
}

/**
 * What the conversation needs from the person now (composer-flow.md "지금 필요한 것"): the
 * approvals, questions, extension requests and continue-or-stop decisions the session's runs wait
 * on, at the end of the timeline, each run in the same response area as Needs you and the run
 * record. Runs come in the conversation's order. While nothing waits it is not there at all.
 */
export function PendingTray({
  sessionId,
  runs,
  onOpenArtifact,
}: {
  sessionId: string;
  runs: readonly RunSummary[];
  onOpenArtifact: (runId: string, artifactVersionId: string) => void;
}) {
  const t = useTranslations('Sessions');
  const trun = useTranslations('Run');
  const { runFor, retainRun } = useServices();
  const tray = useTrayStore();
  // The session's own runs that may still wait. A run read as another session's is answered there.
  const key = runs
    .filter((run) => run.sessionId === sessionId && !TERMINAL_RUN_STATUSES.has(run.status))
    .map((run) => run.runId)
    .join(',');
  const stores = useMemo(
    () => (key ? key.split(',').map((runId) => [runId, runFor(runId)] as const) : []),
    [key, runFor],
  );
  // Its runs are followed here whether or not the timeline has their rows mounted.
  useEffect(() => {
    const releases = stores.map(([runId, store]) => {
      const release = retainRun(runId);
      void store.getState().open(runId);
      return release;
    });
    return () => {
      for (const release of releases) release();
    };
  }, [stores, retainRun]);
  const subscribe = useCallback(
    (notify: () => void) => {
      const off = stores.map(([, store]) => store.subscribe(notify));
      return () => {
        for (const stop of off) stop();
      };
    },
    [stores],
  );
  const read = useCallback(() => waitingOf(stores), [stores]);
  const waitingKey = useSyncExternalStore(subscribe, read, read);
  const waiting = waitingKey
    ? waitingKey.split(',').map((entry) => {
        const at = entry.lastIndexOf(':');
        return { runId: entry.slice(0, at), count: Number(entry.slice(at + 1)) };
      })
    : [];
  const total = waiting.reduce((sum, run) => sum + run.count, 0);
  useLayoutEffect(() => {
    tray.setState({ waiting: total });
  }, [tray, total]);
  useEffect(() => () => tray.setState({ waiting: 0, visible: false }), [tray]);

  const root = useRef<HTMLElement>(null);
  const shown = total > 0;
  // Whether the tray is in view: one observer, on the conversation's scrolling area, with the
  // composer lying over its bottom edge left out.
  useLayoutEffect(() => {
    const element = root.current;
    if (!shown || !element) {
      tray.setState({ visible: false });
      return;
    }
    if (typeof IntersectionObserver === 'undefined') return;
    const timeline = element.closest<HTMLElement>('[data-testid="chat-timeline"]');
    const composer = element
      .closest('[data-chat-view]')
      ?.querySelector<HTMLElement>('[data-testid="chat-composer"]');
    const covered = composer?.dataset.composerSurface === 'floating' ? composer.offsetHeight : 0;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry) tray.setState({ visible: entry.isIntersecting });
      },
      { root: timeline, rootMargin: `0px 0px -${covered}px 0px` },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      tray.setState({ visible: false });
    };
  }, [shown, tray]);
  // A request to respond (a link, the run record's Respond): into view and focused once it shows,
  // and once the conversation's view is in front.
  const revealAt = useStore(tray, (state) => state.revealAt);
  useEffect(() => {
    if (!revealAt || !shown) return;
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      const element = root.current;
      if (!element || performance.now() - revealAt > REVEAL_WINDOW_MS) return;
      if (typeof element.checkVisibility === 'function' && !element.checkVisibility()) {
        if (tries++ < 20) frame = requestAnimationFrame(attempt);
        return;
      }
      tray.setState({ revealAt: 0 });
      element.scrollIntoView?.({ block: 'nearest' });
      element.focus({ preventScroll: true });
    };
    attempt();
    return () => cancelAnimationFrame(frame);
  }, [revealAt, shown, tray]);

  if (!shown) return null;
  return (
    <section
      ref={root}
      data-pending-tray
      tabIndex={-1}
      // Named for assistive tech; on screen the cards and their place say what this is.
      aria-label={t('neededNow')}
      className="flex flex-col gap-3 pb-4 outline-none"
    >
      {waiting.map(({ runId }) => (
        <RunResponseArea
          key={runId}
          session={runFor(runId)}
          onOpenArtifact={(artifactVersionId) => onOpenArtifact(runId, artifactVersionId)}
          policySettingsAction={
            // A way out of a tool card, quieter than its decisions.
            <Button
              variant="ghost"
              render={
                <Link to="/settings/harness" search={{ returnTo: `/sessions/${sessionId}` }} />
              }
            >
              {trun('permissionSettings')}
            </Button>
          }
        />
      ))}
    </section>
  );
}
