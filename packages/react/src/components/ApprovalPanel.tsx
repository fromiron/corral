import type { Receipt } from '@corral/contracts';
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { RunSessionStore } from '../run/session.ts';
import { Button } from '../ui/button.tsx';

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

  useEffect(() => {
    if (criteriaId) void session.getState().loadArtifact(criteriaId);
  }, [session, criteriaId]);

  if (approvals.length === 0) return null;
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
          <p className="font-medium">{t(`kind.${approval.kind}`)}</p>
          {compact ? null : <p className="text-muted">{t(`explain.${approval.kind}`)}</p>}
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
              disabled={busy}
              title={t(`then.${approval.kind}`)}
              onClick={() => void decide(approval.approvalId, 'approve')}
            >
              {t(`approveAs.${approval.kind}`)}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void decide(approval.approvalId, 'reject')}
            >
              {t(`rejectAs.${approval.kind}`)}
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
  );
}
