import type { Receipt } from '@corral/contracts';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import type { RunSessionStore } from '../run/session.ts';

/**
 * Decisions waiting for the person (C-029, Spec §7.5): each names the exact versions and the
 * criteria it is about. Approving applies to that subject only; a newer version needs its own.
 */
export function ApprovalPanel({
  session,
  onOpenArtifact,
}: {
  session: RunSessionStore;
  onOpenArtifact: (artifactVersionId: string) => void;
}) {
  const t = useTranslations('Approvals');
  const all = useStore(session, (s) => s.projection?.approvals);
  const approvals = useMemo(
    () => Object.values(all ?? {}).filter((a) => a.status === 'pending'),
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
  const decide = async (approvalId: string, decision: 'approve' | 'reject') => {
    setBusy(true);
    try {
      const receipt = await session.getState().resolveApproval(approvalId, decision);
      setRefused(receipt.error ? receipt : null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="approvals-heading" className="flex flex-col gap-2">
      <h3 id="approvals-heading" className="text-sm font-semibold">
        {t('heading')}
      </h3>
      {approvals.map((approval) => (
        <article
          key={approval.approvalId}
          data-testid={`approval-${approval.approvalId}`}
          className="flex flex-col gap-2 rounded-md border border-warning p-2 text-xs"
        >
          <p className="font-medium">{t(`kind.${approval.kind}`)}</p>
          <p className="text-muted">{t(`explain.${approval.kind}`)}</p>
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-muted">{t('subject')}</span>
            {approval.subjectVersionIds.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => onOpenArtifact(id)}
                className="rounded border border-line px-1 font-mono"
              >
                {id}
              </button>
            ))}
          </div>
          {criteria ? (
            <div className="text-muted">
              {t('criteria')}
              <ul className="list-disc pl-5">
                {criteria.split('\n').map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide(approval.approvalId, 'approve')}
              className="rounded-md bg-accent px-3 py-1 font-medium text-on-accent disabled:opacity-50"
            >
              {t('approve')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide(approval.approvalId, 'reject')}
              className="rounded-md border border-line px-3 py-1 disabled:opacity-50"
            >
              {t('reject')}
            </button>
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
