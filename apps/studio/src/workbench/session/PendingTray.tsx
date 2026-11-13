import { TERMINAL_RUN_STATUSES } from '@corral/contracts';
import { pendingInteractions, type RunSummary } from '@corral/core';
import { RequestRunContext, type RunSessionStore } from '@corral/react';
import { Button } from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useServices } from '../../services.tsx';
import { RunResponseArea } from '../RunResponseArea.tsx';
import { type TrayPlacement, useTrayStore } from './pendingTrayState.ts';

export {
  createPendingTrayStore,
  PendingTrayContext,
  type PendingTrayStore,
  revealPendingTray,
  type TrayPlacement,
  usePendingTray,
  useRespondInConversation,
  useWaitingNoticeAllowed,
} from './pendingTrayState.ts';

/** A request to reveal the tray counts this long, so a late one does not move focus later. */
const REVEAL_WINDOW_MS = 5_000;

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
  // This tray's mark on what it publishes: a tray leaving (another conversation's, replaced by
  // this one) clears only what it wrote itself.
  const [self] = useState(() => ({}));
  useLayoutEffect(() => {
    tray.setState({ waiting: total, owner: self });
  }, [tray, total, self]);
  useEffect(
    () => () => {
      if (tray.getState().owner === self)
        tray.setState({ waiting: 0, placement: 'unknown', owner: null });
    },
    [tray, self],
  );

  const root = useRef<HTMLElement>(null);
  const shown = total > 0;
  // Whether the tray is in view: one observer on the conversation's scrolling area, with the
  // composer lying over its bottom edge left out. The composer grows and shrinks with its lines
  // and notices, so a new height makes a new observer with the new margin. Until the observer
  // first reports it is neither: a tray arriving at the followed end is measured only after the
  // conversation has come to its new end, not where it stood the moment it was added.
  useLayoutEffect(() => {
    const element = root.current;
    const place = (placement: TrayPlacement) => tray.setState({ placement, owner: self });
    if (tray.getState().owner === self) tray.setState({ placement: 'unknown' });
    if (!shown || !element || typeof IntersectionObserver === 'undefined') return;
    const timeline = element.closest<HTMLElement>('[data-testid="chat-timeline"]');
    const composer = element
      .closest('[data-chat-view]')
      ?.querySelector<HTMLElement>('[data-testid="chat-composer"]');
    const coveredBy = () =>
      composer?.dataset.composerSurface === 'floating' ? composer.offsetHeight : 0;
    let observer: IntersectionObserver | null = null;
    let key = '';
    const observe = () => {
      const covered = coveredBy();
      // The conversation hidden (another view in front) and shown again also makes a new
      // observer, so a conversation coming back is measured afresh.
      const next = `${covered}:${timeline?.clientHeight ? 'shown' : 'hidden'}`;
      if (next === key) return;
      key = next;
      observer?.disconnect();
      observer = new IntersectionObserver(
        (entries) => {
          const entry = entries.at(-1);
          if (!entry) return;
          // A conversation not on screen at all (another view in front, no size) says nothing of
          // where the tray stands in it: neither, until it is shown and measured again.
          const unseen = entry.boundingClientRect?.height === 0 || entry.rootBounds?.height === 0;
          place(unseen ? 'unknown' : entry.isIntersecting ? 'in-view' : 'out-of-view');
        },
        { root: timeline, rootMargin: `0px 0px -${covered}px 0px` },
      );
      observer.observe(element);
    };
    observe();
    const resized = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(observe) : null;
    if (composer) resized?.observe(composer);
    if (timeline) resized?.observe(timeline);
    return () => {
      resized?.disconnect();
      observer?.disconnect();
      if (tray.getState().owner === self) tray.setState({ placement: 'unknown' });
    };
  }, [shown, tray, self]);
  // A request to respond for this conversation (a link, the run record's Respond): into view and
  // focused once it shows and the conversation's view is in front; used once, then cleared.
  const reveal = useStore(tray, (state) => state.reveal);
  useEffect(() => {
    if (!reveal || reveal.sessionId !== sessionId || !shown) return;
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      const element = root.current;
      if (!element || performance.now() - reveal.at > REVEAL_WINDOW_MS) return;
      if (typeof element.checkVisibility === 'function' && !element.checkVisibility()) {
        if (tries++ < 20) frame = requestAnimationFrame(attempt);
        return;
      }
      if (tray.getState().reveal === reveal) tray.setState({ reveal: null });
      element.scrollIntoView?.({ block: 'nearest' });
      element.focus({ preventScroll: true });
    };
    attempt();
    return () => cancelAnimationFrame(frame);
  }, [reveal, shown, tray, sessionId]);

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
        // With several runs waiting, each card names its run (as the run's row does).
        <RequestRunContext.Provider
          key={runId}
          value={
            waiting.length > 1
              ? t('runNumber', { number: runs.findIndex((run) => run.runId === runId) + 1 })
              : null
          }
        >
          <RunResponseArea
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
        </RequestRunContext.Provider>
      ))}
    </section>
  );
}
