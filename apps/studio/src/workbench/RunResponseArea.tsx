import { ApprovalPanel, CommandReceipts, type RunSessionStore } from '@corral/react';
import type { Ref } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';

/**
 * A run's one response area: its approvals, questions and extension requests, answered through
 * the run store's command, receipt and revision path. The Run page and Needs you both render it.
 * `receipts` adds the run's open receipts and lost-response retry where no run header shows them.
 */
export function RunResponseArea({
  session,
  onOpenArtifact,
  focusRef,
  receipts = false,
}: {
  session: RunSessionStore;
  onOpenArtifact: (artifactVersionId: string) => void;
  /** The focus target for "respond" and for notification clicks. */
  focusRef?: Ref<HTMLDivElement>;
  receipts?: boolean;
}) {
  const m = useTranslations('RunMonitor');
  const runId = useStore(session, (s) => s.projection?.runId);
  return (
    <section data-testid="run-needs-you" aria-label={m('needsYou')}>
      <div ref={focusRef} data-run-response={runId} tabIndex={-1} className="outline-none">
        <ApprovalPanel session={session} showPlan={false} onOpenArtifact={onOpenArtifact} />
        {receipts && runId ? (
          <CommandReceipts session={session} target={`run:${runId}`} openOnly />
        ) : null}
      </div>
    </section>
  );
}
