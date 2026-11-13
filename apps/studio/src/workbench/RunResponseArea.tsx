import { pendingInteractions } from '@corral/core';
import {
  ApprovalPanel,
  CommandReceipts,
  ContinueDecisions,
  isContinueDecision,
  type RunSessionStore,
} from '@corral/react';
import { Button } from '@corral/react/design-kit';
import type { ReactNode, Ref } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';

/**
 * A run's one response area: its approvals, questions, extension requests and continue-or-stop
 * decisions, answered through the run store's command, receipt and revision path. The Run page,
 * Needs you and a conversation's needed-now tray all render it under their own frame, so it adds
 * no visible heading of its own.
 * `receipts` adds the run's open receipts and lost-response retry where no run header shows them.
 * `action` is a control of the host's frame (the Run page's close): it sits at the end of the
 * area's first row, so it never takes a row of its own.
 * `onRespond` makes the area read-only: another place on the same screen answers the run (a
 * session's run record, whose conversation holds the response place), and "Respond" goes there.
 */
export function RunResponseArea({
  session,
  onOpenArtifact,
  focusRef,
  receipts = false,
  action,
  policySettingsAction,
  onRespond,
}: {
  session: RunSessionStore;
  onOpenArtifact: (artifactVersionId: string) => void;
  /** The focus target for "respond" and for notification clicks. */
  focusRef?: Ref<HTMLDivElement>;
  receipts?: boolean;
  action?: ReactNode;
  /** A way out of a tool card to the rules of later runs; navigation only. */
  policySettingsAction?: ReactNode;
  onRespond?: () => void;
}) {
  const status = useTranslations('Status');
  const m = useTranslations('RunMonitor');
  const runId = useStore(session, (s) => s.projection?.runId);
  const waiting = useStore(session, (s) => pendingInteractions(s.events, s.projection).length);
  return (
    <section data-testid="run-needs-you" aria-label={status('awaiting_user')}>
      <div ref={focusRef} data-run-response={runId} tabIndex={-1} className="outline-none">
        <ApprovalPanel
          session={session}
          showPlan={false}
          headed={false}
          onOpenArtifact={onOpenArtifact}
          readOnly={Boolean(onRespond)}
          {...(onRespond ? {} : { skip: isContinueDecision })}
          {...(action ? { action } : {})}
          {...(policySettingsAction && !onRespond ? { policySettingsAction } : {})}
        />
        {onRespond ? (
          waiting > 0 ? (
            <div className="mt-2 flex justify-end">
              <Button variant="primary" data-testid="respond-in-conversation" onClick={onRespond}>
                {m('respond', { count: waiting })}
              </Button>
            </div>
          ) : null
        ) : (
          <ContinueDecisions session={session} />
        )}
        {receipts && runId ? (
          <CommandReceipts session={session} target={`run:${runId}`} openOnly />
        ) : null}
      </div>
    </section>
  );
}
