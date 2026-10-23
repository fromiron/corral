import type { WorkspacesApi } from '@corral/client';
import type { LspProposal, LspProposalSummary } from '@corral/contracts';
import {
  Button,
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
  Select,
} from '@corral/react/design-kit';
import { RefreshCw } from '@corral/react/icons';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';

export function LspProposals({
  api,
  sessionId,
  version,
  onApplied,
  renderFile,
}: {
  api: Pick<
    WorkspacesApi,
    'lspProposals' | 'lspProposal' | 'applyLspProposal' | 'dismissLspProposal'
  >;
  sessionId: string;
  version: number;
  onApplied(): void;
  renderFile(proposal: LspProposal, file: LspProposal['files'][number]): ReactNode;
}) {
  const t = useTranslations('LspProposals');
  const [items, setItems] = useState<LspProposalSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<LspProposal | null>(null),
    [path, setPath] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    void version;
    void refresh;
    let active = true;
    void api.lspProposals(sessionId).then(
      (items) => {
        if (active) setItems(items);
      },
      () => {
        if (active) setError(t('loadFailed'));
      },
    );
    return () => {
      active = false;
    };
  }, [api, sessionId, version, refresh, t]);
  useEffect(() => {
    setDetail(null);
    setError('');
    setPath('');
    if (!selected) return;
    let active = true;
    void api.lspProposal(sessionId, selected).then(
      (proposal) => {
        if (active) {
          setDetail(proposal);
          setPath(proposal.files[0]?.path ?? '');
        }
      },
      () => {
        if (active) setError(t('loadFailed'));
      },
    );
    return () => {
      active = false;
    };
  }, [api, sessionId, selected, t]);
  async function act(action: 'apply' | 'dismiss') {
    if (!detail) return;
    setBusy(true);
    setError('');
    try {
      const updated = await (action === 'apply'
        ? api.applyLspProposal(sessionId, detail.proposalId, detail.hash)
        : api.dismissLspProposal(sessionId, detail.proposalId, detail.hash));
      setDetail(updated);
      setRefresh((current) => current + 1);
      if (action === 'apply') onApplied();
    } catch (error) {
      setError(error instanceof Error ? error.message : t('loadFailed'));
    } finally {
      setBusy(false);
    }
  }
  const file = detail?.files.find((file) => file.path === path);
  return (
    <section className="flex flex-col gap-2 border-t border-line pt-3" aria-label={t('heading')}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t('heading')}</h3>
        <Button
          variant="ghost"
          size="icon-compact"
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={() => setRefresh((current) => current + 1)}
        >
          <RefreshCw />
        </Button>
      </div>
      {/* What a proposal is matters once there is one; an empty list says so on its own. */}
      <p className="text-xs text-muted-foreground">{items.length ? t('hint') : t('empty')}</p>
      {items.map((item) => (
        <div key={item.proposalId} className="flex flex-col gap-1 border-b border-line pb-2">
          <Button variant="tertiary" size="compact" onClick={() => setSelected(item.proposalId)}>
            {t('review', { title: item.title })}
          </Button>
          <p className="text-xs text-muted-foreground">
            {t(`states.${item.state}`)} · {t('files', { count: item.files.length })}
          </p>
        </div>
      ))}
      {!selected && error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setSelected(null);
        }}
      >
        <DialogPopup className="w-[min(95vw,1000px)] max-w-[1000px] gap-3 overflow-auto p-5">
          <DialogTitle>{detail?.title ?? t('heading')}</DialogTitle>
          <DialogDescription>{t('applyHint')}</DialogDescription>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          {!detail && !error ? <p role="status">{t('loading')}</p> : null}
          {detail ? (
            <>
              <p role="status" className="text-sm font-medium">
                {t(`states.${detail.state}`)}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('source', { server: detail.serverId, revision: detail.configRevision })} ·{' '}
                <span className="font-mono" title={detail.hash}>
                  {detail.hash.slice(0, 12)}
                </span>
              </p>
              <div className="flex flex-col gap-1 text-sm">
                <span aria-hidden="true">{t('file')}</span>
                <Select
                  label={t('file')}
                  disabled={busy}
                  value={path}
                  onValueChange={setPath}
                  options={detail.files.map((file) => ({
                    value: file.path,
                    label: `${file.path} · ${t(
                      `outcomes.${detail.outcomes.find((outcome) => outcome.path === file.path)?.state ?? 'pending'}`,
                    )}`,
                  }))}
                />
              </div>
              {file ? renderFile(detail, file) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy || detail.state !== 'pending'}
                  onClick={() => void act('apply')}
                >
                  {busy ? t('applying') : t('apply', { count: detail.files.length })}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy || detail.state !== 'pending'}
                  onClick={() => void act('dismiss')}
                >
                  {t('dismiss')}
                </Button>
              </div>
              {detail.state === 'partial' || detail.state === 'failed' ? (
                <p className="text-sm text-warning">{t('partialHint')}</p>
              ) : null}
            </>
          ) : null}
        </DialogPopup>
      </Dialog>
    </section>
  );
}
