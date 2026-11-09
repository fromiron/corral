import type { CorralSummary, RunSummary, WorkSession } from '@corral/core';
import { Button, cn, useSize } from '@corral/react/design-kit';
import { FolderOpen } from '@corral/react/icons';
import { useEffect } from 'react';
import { useTranslations } from 'use-intl';
import { useBinding } from '../../pages/FilesViews.tsx';
import { sessionRoute } from '../../router.tsx';
import { useServices } from '../../services.tsx';
import { ChatView } from '../ChatView.tsx';
import type { FileReference } from '../FilePanel.tsx';
import { MeetingHandoffLinks } from '../MeetingHandoff.tsx';
import type { SessionPanel } from '../panels/registry.ts';
import type { SessionSearch } from '../panels/routes.ts';
import { WorkFolderNotice } from '../WorkFolderNotice.tsx';
import { Composer } from './Composer.tsx';
import { EntryCard, RunCard, RunChecks, useRunChecks } from './SessionEntries.tsx';

/** The kit's display weight (its `fontWeights.bold`, which the kit entry does not export). */
const DISPLAY_WEIGHT = "'wght' 700, 'opsz' 25";

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
  const queued = session.entries.filter((e) => e.state === 'queued');
  const runChecks = useRunChecks(session.sessionId, runs);
  const artifactMetadataVersion = runs.findLast((run) => run.status === 'succeeded')?.runId ?? '';
  const td = useTranslations('Desktop');
  const size = useSize();
  // Nothing asked and nothing run: the conversation is the kit home composition.
  const home = session.entries.length === 0 && loose.length === 0;
  return (
    <RunChecks.Provider value={runChecks}>
      <ChatView
        centerEmpty
        key={session.sessionId}
        sessionId={session.sessionId}
        messageId={messageId}
        header={
          <>
            <MeetingHandoffLinks
              key={`handoffs:${session.sessionId}`}
              sessionId={session.sessionId}
            />
            <WorkFolderNotice
              key={`folder:${session.sessionId}`}
              sessionId={session.sessionId}
              revision={runs.map((run) => `${run.runId}:${run.status}`).join(',')}
              onSetup={() => onPanel('changes')}
            />
          </>
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
            reference={reference}
            onReferenceUsed={onReferenceUsed}
            home={home}
          />
        }
      >
        <section aria-label={t('heading')}>
          {home ? (
            // The kit home composition: a centered title right above the composer.
            <div className="flex flex-col items-center gap-3 pb-4 text-center">
              <h2
                className={cn(size.type.display, 'm-0 text-foreground')}
                style={{ fontVariationSettings: DISPLAY_WEIGHT }}
              >
                {td('homeTitle')}
              </h2>
              {/* The purpose given when the session was made, not an explanation. */}
              {session.objective ? (
                <p className="m-0 max-w-md text-ui text-muted-foreground">{session.objective}</p>
              ) : null}
              {workspaces && binding === null ? (
                <Button variant="ghost" size="compact" onClick={() => onPanel('changes')}>
                  <FolderOpen />
                  {td('workFolder')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </section>
      </ChatView>
    </RunChecks.Provider>
  );
}
