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
import { ChatView } from '../ChatView.tsx';
import type { FileReference } from '../FilePanel.tsx';
import { MeetingHandoffLinks } from '../MeetingHandoff.tsx';
import type { SessionPanel } from '../panels/registry.ts';
import type { SessionSearch } from '../panels/routes.ts';
import { useFolderAccess } from '../WorkFolderNotice.tsx';
import { Composer } from './Composer.tsx';
import { EntryCard, RunCard, RunChecks, useRunChecks } from './SessionEntries.tsx';

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
  reference,
  onReferenceUsed,
  onPanel,
}: {
  session: WorkSession;
  team: CorralSummary | null;
  corrals: CorralSummary[];
  runs: RunSummary[];
  active: RunSummary | null;
  liveRunId: string | null;
  selectedRunId: string | null;
  onChange: () => void;
  reference: FileReference | null;
  onReferenceUsed: () => void;
  onPanel: (panel: SessionPanel, run?: Partial<SessionSearch>) => void;
}) {
  const t = useTranslations('Sessions');
  const { runFor, sessionFor, retainRun, workspaces } = useServices();
  const { binding } = useBinding(session.projectId);
  const liveSession = liveRunId ? runFor(liveRunId) : sessionFor(session.sessionId);
  const currentSearch = sessionRoute.useSearch();
  const messageId = currentSearch.message;
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
  return (
    <RunChecks.Provider value={runChecks}>
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
          ...session.entries
            .filter((e) => e.state !== 'queued' && e.state !== 'dismissed')
            .map((entry) => ({
              id: entry.entryId,
              content: (
                <EntryCard
                  sessionId={session.sessionId}
                  entry={entry}
                  runs={runs}
                  artifactMetadataVersion={artifactMetadataVersion}
                  onPanel={onPanel}
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
        composer={
          <Composer
            key={session.sessionId}
            runControlsOwnConfirmation={
              currentSearch.panel !== 'run' || selectedRunId === active?.runId
            }
            session={session}
            team={team}
            corrals={corrals}
            runs={runs}
            active={active}
            selectedRunId={selectedRunId}
            onViewRun={(run) => onPanel('run', { run })}
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
    </RunChecks.Provider>
  );
}
