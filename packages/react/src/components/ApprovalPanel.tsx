import { CheckPlan, type Receipt } from '@corral/contracts';
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { RunSessionStore } from '../run/session.ts';
import { Button } from '../ui/button.tsx';
import { ExtensionUiPanel } from './ExtensionUiPanel.tsx';
import { RecipeStatusPanel } from './RecipeStatusPanel.tsx';

/**
 * Decisions waiting for the person (C-029, Spec §7.5): each names the exact versions and the
 * criteria it is about. Approving applies to that subject only; a newer version needs its own.
 */
export function ApprovalPanel({
  session,
  onOpenArtifact,
  className,
  compact = false,
}: {
  session: RunSessionStore;
  onOpenArtifact: (artifactVersionId: string) => void;
  /** Placement around the cards; nothing is drawn while no approval waits. */
  className?: string;
  /** A one-row strip beside what is being read (the results view): no explanations. */
  compact?: boolean;
}) {
  const t = useTranslations('Approvals');
  const headingId = useId();
  const all = useStore(session, (s) => s.projection?.approvals);
  const artifacts = useStore(session, (s) => s.projection?.artifacts);
  const approvals = useMemo(
    () => Object.values(all ?? {}).filter((a) => a.status === 'pending'),
    [all],
  );
  const done = useMemo(
    () => Object.values(all ?? {}).filter((a) => a.status === 'approved'),
    [all],
  );
  const criteriaId = approvals[0]?.criteriaVersionId;
  const criteria = useStore(session, (s) => (criteriaId ? s.artifactTexts[criteriaId] : undefined));
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Receipt | null>(null);
  const [checkPlans, setCheckPlans] = useState<Record<string, CheckPlan | null>>({});

  useEffect(() => {
    let active = true;
    for (const approval of approvals) {
      if (!approval.tool) continue;
      const { bodyRef, fingerprint, targetTree } = approval.tool;
      void (async () => {
        try {
          if (session.getState().artifactTexts[bodyRef] === undefined)
            await session.getState().loadArtifact(bodyRef);
          const text = session.getState().artifactTexts[bodyRef];
          const plan = CheckPlan.parse(JSON.parse(text ?? 'null'));
          if (
            plan.fingerprint !== fingerprint ||
            plan.tree !== targetTree ||
            (plan.purpose ?? 'check') !== (approval.tool?.purpose ?? 'check')
          )
            throw new Error('approval changed');
          if (active) setCheckPlans((previous) => ({ ...previous, [bodyRef]: plan }));
        } catch {
          if (active) setCheckPlans((previous) => ({ ...previous, [bodyRef]: null }));
        }
      })();
    }
    return () => {
      active = false;
    };
  }, [approvals, session]);

  useEffect(() => {
    if (criteriaId) void session.getState().loadArtifact(criteriaId);
  }, [session, criteriaId]);

  if (approvals.length === 0)
    return (
      <>
        <RecipeStatusPanel session={session} onOpenArtifact={onOpenArtifact} />
        <ExtensionUiPanel session={session} />
      </>
    );
  const label = (id: string) =>
    artifacts?.[id] ? `${artifacts[id].name} v${artifacts[id].version}` : id;
  const decide = async (approvalId: string, decision: 'approve' | 'reject') => {
    setBusy(true);
    try {
      const receipt = await session.getState().resolveApproval(approvalId, decision);
      setRefused(receipt.error ? receipt : null);
    } catch {
      // The session preserves the unconfirmed receipt; approval stays pending.
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <RecipeStatusPanel session={session} onOpenArtifact={onOpenArtifact} />
      <ExtensionUiPanel session={session} />
      <section aria-labelledby={headingId} className={`flex flex-col gap-2 ${className ?? ''}`}>
        <h3 id={headingId} className={compact ? 'sr-only' : 'text-ui font-semibold'}>
          {t('heading')}
        </h3>
        {/* UX-11: decisions already made in this run stay in view, so the next one reads as a
          new step rather than a retry of the last. */}
        {(compact ? [] : done).map((approval) => (
          <p
            key={approval.approvalId}
            data-testid={`approved-${approval.approvalId}`}
            className="text-xs text-muted"
          >
            {t('done', {
              step: t(`kind.${approval.kind}`),
              subject: label(approval.subjectVersionIds[0] ?? ''),
            })}
          </p>
        ))}
        {approvals.map((approval) => (
          <article
            key={approval.approvalId}
            data-testid={`approval-${approval.approvalId}`}
            className={
              compact
                ? 'flex flex-wrap items-center gap-2 rounded-lg border border-warning/50 bg-warning/5 px-2.5 py-2 text-xs'
                : 'flex flex-col gap-2 rounded-xl border border-warning/50 bg-warning/5 p-3 text-xs'
            }
          >
            <p className="font-medium">
              {approval.tool
                ? t(approval.tool.purpose === 'lsp' ? 'lspHeading' : 'checkHeading')
                : t(`kind.${approval.kind}`)}
            </p>
            {approval.tool ? (
              <div className="flex min-w-0 flex-col gap-1">
                {checkPlans[approval.tool.bodyRef] ? (
                  <>
                    <p>{checkPlans[approval.tool.bodyRef]?.name}</p>
                    {checkPlans[approval.tool.bodyRef]?.query ? (
                      <p>
                        {checkPlans[approval.tool.bodyRef]?.query?.operation} ·{' '}
                        {checkPlans[approval.tool.bodyRef]?.query?.path}
                      </p>
                    ) : null}
                    <code className="whitespace-pre-wrap break-all">
                      {checkPlans[approval.tool.bodyRef]?.argv.join(' ')}
                    </code>
                    <p className="text-muted">
                      {t('checkScope', {
                        execution: approval.tool.executionId,
                        attempt: approval.tool.attemptNo,
                        revision: checkPlans[approval.tool.bodyRef]?.configRevision ?? 0,
                        fingerprint: approval.tool.fingerprint.slice(0, 12),
                        tree: approval.tool.targetTree.slice(0, 12),
                      })}
                    </p>
                    <p className="text-muted">
                      {t(approval.tool.purpose === 'lsp' ? 'lspOnce' : 'checkOnce')}
                    </p>
                  </>
                ) : (
                  <p role={checkPlans[approval.tool.bodyRef] === null ? 'alert' : 'status'}>
                    {t(
                      checkPlans[approval.tool.bodyRef] === null
                        ? 'checkUnavailable'
                        : 'checkLoading',
                    )}
                  </p>
                )}
              </div>
            ) : null}
            {compact || approval.tool ? null : (
              <p className="text-muted">{t(`explain.${approval.kind}`)}</p>
            )}
            {approval.tool ? null : (
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-muted">{t('subject')}</span>
                {approval.subjectVersionIds.map((id) => (
                  <Button
                    key={id}
                    variant="outline"
                    size="xs"
                    title={id}
                    onClick={() => onOpenArtifact(id)}
                  >
                    {label(id)}
                  </Button>
                ))}
              </div>
            )}
            {criteria && !compact ? (
              <div className="text-muted">
                {t('criteria')}
                <ul className="list-disc pl-5">
                  {criteria.split('\n').map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className={`flex gap-2 ${compact ? 'ml-auto' : ''}`}>
              <Button
                size="sm"
                disabled={busy || !!(approval.tool && !checkPlans[approval.tool.bodyRef])}
                title={
                  approval.tool
                    ? t(approval.tool.purpose === 'lsp' ? 'lspOnce' : 'checkOnce')
                    : t(`then.${approval.kind}`)
                }
                onClick={() => void decide(approval.approvalId, 'approve')}
              >
                {approval.tool
                  ? t(approval.tool.purpose === 'lsp' ? 'approveLsp' : 'approveCheck')
                  : t(`approveAs.${approval.kind}`)}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void decide(approval.approvalId, 'reject')}
              >
                {approval.tool
                  ? t(approval.tool.purpose === 'lsp' ? 'rejectLsp' : 'rejectCheck')
                  : t(`rejectAs.${approval.kind}`)}
              </Button>
            </div>
            {refused?.error ? (
              <p role="alert" className="text-danger">
                {t('refused', { message: refused.error.message })}
              </p>
            ) : null}
          </article>
        ))}
      </section>
    </>
  );
}
