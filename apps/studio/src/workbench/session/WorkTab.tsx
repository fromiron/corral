import {
  type CorralSummary,
  queuedEntriesInStartOrder,
  type RunSummary,
  type WorkSession,
} from '@corral/core';
import { cn, fontWeights, useSize } from '@corral/react/design-kit';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useBinding } from '../../pages/FilesViews.tsx';
import { sessionRoute } from '../../router.tsx';
import { useServices } from '../../services.tsx';
import { AdviceArrival } from '../adviceArrival.ts';
import { ChatView } from '../ChatView.tsx';
import type { FileReference } from '../FilePanel.tsx';
import { MeetingHandoffLinks } from '../MeetingHandoff.tsx';
import type { SessionPanel } from '../panels/registry.ts';
import type { SessionSearch } from '../panels/routes.ts';
import { ReplySelection, runRow } from '../ReplySelection.tsx';
import { useFolderAccess } from '../WorkFolderNotice.tsx';
import { Composer } from './Composer.tsx';
import { inConversation, placeEntries, type SteerRecord } from './entryMeta.ts';
import { PendingTray } from './PendingTray.tsx';
import { useRunRecords } from './runRecords.ts';
import { EntryCard, RunCard, RunChecks, useRunChecks } from './SessionEntries.tsx';

const NO_READS = { read: 0, started: () => 0 };

/** The conversation: what was asked, the runs it started, decisions waiting, and the input box. */
export function WorkTab({
  session,
  team,
  corrals,
  runs,
  active,
  liveRunId,
  selectedRunId,
  onChange,
  sessionReads = NO_READS,
  runsListed = true,
  reference,
  onReferenceUsed,
  onPanel,
  onPlace,
}: {
  session: WorkSession;
  team: CorralSummary | null;
  corrals: CorralSummary[];
  runs: RunSummary[];
  active: RunSummary | null;
  liveRunId: string | null;
  selectedRunId: string | null;
  onChange: () => void;
  /** The session reads: the number of the latest one back, and of the latest one asked for. */
  sessionReads?: { read: number; started: () => number };
  /** Whether the run list has been read since the page opened. */
  runsListed?: boolean;
  reference: FileReference | null;
  onReferenceUsed: () => void;
  onPanel: (panel: SessionPanel, run?: Partial<SessionSearch>) => void;
  /**
   * Moves the conversation to an item (its `message`), loading it when it is outside the window;
   * `undefined` lets the place go. Nothing else on the page changes.
   */
  onPlace?: (message: string | undefined) => void;
}) {
  const t = useTranslations('Sessions');
  const { runFor, sessionFor, retainRun, workspaces, workspaceId } = useServices();
  const { binding } = useBinding(session.projectId);
  const liveSession = liveRunId ? runFor(liveRunId) : sessionFor(session.sessionId);
  const currentSearch = sessionRoute.useSearch();
  const linkedMessage = currentSearch.message;
  useEffect(() => {
    if (!liveRunId) return;
    const release = retainRun(liveRunId);
    void liveSession.getState().open(liveRunId);
    return release;
  }, [liveSession, liveRunId, retainRun]);
  // Entries in order; runs that no entry names (started elsewhere) are shown after them.
  const named = new Set(session.entries.flatMap((e) => (e.runId ? [e.runId] : [])));
  const loose = runs.filter((r) => !named.has(r.runId));
  // In the order they start: carried requests first (features/composer-flow.md).
  const queued = queuedEntriesInStartOrder(session);
  const runChecks = useRunChecks(session.sessionId, runs);
  const artifactMetadataVersion = runs.findLast((run) => run.status === 'succeeded')?.runId ?? '';
  const td = useTranslations('Desktop');
  const size = useSize();
  // Nothing asked and nothing run: the conversation is the kit home composition.
  const home = session.entries.length === 0 && loose.length === 0;
  const [sent, setSent] = useState(0);
  const folderAccess = useFolderAccess(
    session.sessionId,
    session.projectId,
    runs.map((run) => `${run.runId}:${run.status}`).join(','),
  );
  const folderAction =
    folderAccess === 'unlinked' || folderAccess === 'untrusted' || folderAccess === 'missing';
  const rowOf = (runId: string) => runRow(session.entries, loose, runId);
  // What became of each instruction, from its run's record (features/composer-flow.md). One
  // seen to expire unread asks for the session, which alone says whether it was carried.
  const { records, watched } = useRunRecords(
    session.entries.flatMap((e) => (e.intent === 'steer' && e.runId ? [e.runId] : [])),
    runs,
    { started: sessionReads.started, onWatchedExpiry: onChange },
  );
  const steerRecord = (entry: (typeof session.entries)[number]): SteerRecord | null | undefined => {
    const record = entry.runId ? records.get(entry.runId) : undefined;
    if (!record) return undefined;
    const directive = Object.values(record.projection.directives).find(
      (item) => entry.commandId != null && item.commandId === entry.commandId,
    );
    return directive ? { ...record, directive } : null;
  };
  const placement = placeEntries(session.entries, (entry) => {
    const record = steerRecord(entry);
    return record === undefined ? undefined : (record?.directive ?? null);
  });
  const steerProps = (entry: (typeof session.entries)[number]) => {
    const record = steerRecord(entry);
    const seen = record ? watched.get(record.directive.directiveId) : undefined;
    // Held with what it was until a session read asked after it saw the expiry comes back.
    const held = seen && sessionReads.read <= seen.at ? { heldAs: seen.before } : {};
    return { record, ...held };
  };
  // A carried request drawn as nothing is reached through the message it came from. An advice
  // is reached through its run's row, brought into the window like a linked message.
  const adviceRun = currentSearch.advice;
  const linked = linkedMessage ?? (adviceRun ? rowOf(adviceRun) : undefined);
  const messageId = (linked && placement.emptyFor.get(linked)) ?? linked;
  return (
    <RunChecks.Provider value={runChecks}>
      <AdviceArrival.Provider value={adviceRun ?? null}>
        {/* The conversation's one selection listener; its toolbar floats over the rows. */}
        {workspaceId ? (
          <ReplySelection
            target={{
              hostId: workspaceId,
              projectId: session.projectId,
              sessionId: session.sessionId,
            }}
            rowOf={rowOf}
          />
        ) : null}
        <ChatView
          centerEmpty
          key={session.sessionId}
          sessionId={session.sessionId}
          messageId={messageId}
          sent={sent}
          header={
            <MeetingHandoffLinks
              key={`handoffs:${session.sessionId}`}
              sessionId={session.sessionId}
            />
          }
          items={[
            ...session.entries.filter(inConversation).map((entry) => ({
              id: entry.entryId,
              content: (
                <EntryCard
                  sessionId={session.sessionId}
                  entry={entry}
                  runs={runs}
                  artifactMetadataVersion={artifactMetadataVersion}
                  onPanel={onPanel}
                  {...(entry.intent === 'steer' ? steerProps(entry) : {})}
                  carried={placement.carriedOf.get(entry.entryId)}
                  carriedHere={placement.carriesActions.has(entry.entryId)}
                  runOnly={placement.runOnly.has(entry.entryId)}
                  sourceShown={placement.sourced.has(entry.entryId)}
                  runsListed={runsListed}
                />
              ),
            })),
            ...loose.map((run) => ({
              id: run.runId,
              content: (
                <RunCard
                  run={run}
                  number={runs.findIndex((item) => item.runId === run.runId) + 1}
                  artifactMetadataVersion={artifactMetadataVersion}
                  onPanel={onPanel}
                />
              ),
            })),
          ]}
          tray={
            <PendingTray
              sessionId={session.sessionId}
              runs={runs}
              // A decision's subject opens as a document over the run record, as on the run page.
              onOpenArtifact={(run, artifact) =>
                onPanel('run', { run, view: 'run', artifact, result: undefined })
              }
            />
          }
          composer={
            <Composer
              key={session.sessionId}
              // The run view showing the running run asks its own confirmation.
              runControlsOwnConfirmation={
                currentSearch.panel === 'run' && selectedRunId === active?.runId
              }
              session={session}
              team={team}
              corrals={corrals}
              runs={runs}
              active={active}
              selectedRunId={selectedRunId}
              onViewRun={(run, execution) =>
                onPanel('run', { run, ...(execution ? { execution } : {}) })
              }
              revealRun={(run) => {
                if (!onPlace) return false;
                // The conversation's own place for it: the request that started it, else the run.
                const item = run
                  ? (session.entries.find((entry) => entry.runId === run)?.entryId ??
                    loose.find((summary) => summary.runId === run)?.runId)
                  : undefined;
                if (run && !item) return false;
                onPlace(item);
                return true;
              }}
              queued={queued}
              onChange={onChange}
              onSent={() => setSent((count) => count + 1)}
              reference={reference}
              onReferenceUsed={onReferenceUsed}
              home={home}
              folderAccess={folderAccess}
              {...(folderAction
                ? { onFolderAction: () => onPanel('changes') }
                : folderAccess === 'unknown' && home && workspaces && binding === null
                  ? { onWorkFolder: () => onPanel('changes') }
                  : {})}
            />
          }
        >
          <section aria-label={t('heading')}>
            {home ? (
              // The kit home composition: a centered title right above the composer.
              <div className="flex flex-col items-center gap-2 text-center">
                <h2
                  className={cn(size.type.display, 'm-0 text-foreground')}
                  style={{ fontVariationSettings: fontWeights.bold }}
                >
                  {td('homeTitle')}
                </h2>
                {/* The purpose given when the session was made, not an explanation. */}
                {session.objective ? (
                  <p className="m-0 max-w-md text-ui text-muted-foreground">{session.objective}</p>
                ) : null}
              </div>
            ) : null}
          </section>
        </ChatView>
      </AdviceArrival.Provider>
    </RunChecks.Provider>
  );
}
