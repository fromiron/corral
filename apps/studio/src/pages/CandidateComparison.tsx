import type { CandidateChanges, WorkspacesApi } from '@corral/client';
import type {
  CandidateComparisonView,
  CandidateView,
  Receipt,
  RunCommand,
} from '@corral/contracts';
import type { RuntimeTransport } from '@corral/core';
import { Button, Dialog, DialogDescription, DialogPopup, DialogTitle } from '@corral/react/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { newCommandId } from '../sessionActions.ts';

type CandidateCommand = Extract<RunCommand, { type: 'select_candidate' | 'cancel_candidate' }>;

/** Candidate inspection shares the review surface; only the Coordinator can select a winner. */
export function CandidateComparison({
  api,
  transport,
  runId,
  onApplied,
  renderFile,
}: {
  api: Pick<WorkspacesApi, 'candidateComparison' | 'candidateChanges'>;
  transport: RuntimeTransport;
  runId: string;
  onApplied(): void;
  renderFile(candidate: CandidateView, path: string): ReactNode;
}) {
  const t = useTranslations('Candidates');
  const [comparison, setComparison] = useState<CandidateComparisonView | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const [changes, setChanges] = useState<CandidateChanges | null>(null);
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<CandidateCommand | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const mounted = useRef(false);
  const applied = useRef<string | null>(null);
  const callback = useRef(onApplied);
  callback.current = onApplied;
  const candidate = comparison?.candidates.find((item) => item.candidateId === selected);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    mounted.current = true;
    void (async () => {
      const [{ seq }, value] = await Promise.all([
        transport.getSnapshot(runId),
        api.candidateComparison(runId),
      ]);
      if (!active) return;
      setComparison(value);
      unsubscribe = transport.subscribe(runId, seq, {
        onEvent(event) {
          if (active && event.type === 'candidate.comparison_changed') setComparison(event.payload);
        },
        onError() {
          if (active) setError(t('loadFailed'));
        },
      });
    })().catch((error: unknown) => {
      if (active) setError(error instanceof Error ? error.message : t('loadFailed'));
    });
    return () => {
      active = false;
      mounted.current = false;
      unsubscribe?.();
    };
  }, [api, transport, runId, t]);

  useEffect(() => {
    if (comparison?.status !== 'selected' || !comparison.selectedCandidateId) return;
    if (pending?.type === 'select_candidate') setPending(null);
    if (applied.current === comparison.selectedCandidateId) return;
    applied.current = comparison.selectedCandidateId;
    callback.current();
  }, [comparison, pending]);

  const tree = candidate?.tree;
  useEffect(() => {
    setChanges(null);
    setPath('');
    if (!open || !selected || !tree) return;
    let active = true;
    void api.candidateChanges(runId, selected, tree).then(
      (value) => {
        if (active) {
          setChanges(value);
          setPath(value.files[0]?.path ?? '');
        }
      },
      (error: unknown) => {
        if (active) setError(error instanceof Error ? error.message : t('loadFailed'));
      },
    );
    return () => {
      active = false;
    };
  }, [api, runId, selected, tree, open, t]);

  async function refresh() {
    try {
      const value = await api.candidateComparison(runId);
      if (mounted.current) setComparison(value);
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : t('loadFailed'));
    }
  }
  function accept(result: Receipt) {
    if (!mounted.current) return;
    setReceipt(result);
    if (result.error) setError(result.error.message);
    if (result.status !== 'accepted' && result.status !== 'queued') setPending(null);
    void refresh();
  }
  async function act(type: CandidateCommand['type']) {
    if (!candidate || busy || pending) return;
    if (type === 'select_candidate' && (!tree || changes?.to !== tree)) return;
    setBusy(true);
    setError('');
    try {
      const { projection } = await transport.getSnapshot(runId);
      if (!mounted.current) return;
      const common = {
        schemaVersion: '0.1' as const,
        commandId: newCommandId(),
        runId,
        expectedControlRevision: projection.controlRevision,
      };
      let command: CandidateCommand;
      if (type === 'select_candidate') {
        if (!tree) return;
        command = { ...common, type, payload: { candidateId: candidate.candidateId, tree } };
      } else command = { ...common, type, payload: { candidateId: candidate.candidateId } };
      setPending(command);
      setReceipt(null);
      accept(await transport.sendCommand(command));
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : t('loadFailed'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function recover() {
    if (!pending || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await transport.getReceipt(runId, pending.commandId);
      if (result) accept(result);
      else if (mounted.current) setError(t('receiptMissing'));
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : t('loadFailed'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  if (!comparison)
    return error ? (
      <div role="alert" className="flex flex-col gap-2 text-xs">
        <p>{error}</p>
        <Button size="xs" variant="outline" onClick={() => void refresh()}>
          {t('refresh')}
        </Button>
      </div>
    ) : null;
  const selectable = comparison.status === 'awaiting_selection';
  return (
    <section
      aria-label={t('heading')}
      className="flex flex-col gap-2 border-b border-line pb-3 text-xs"
    >
      <h3 className="text-sm font-semibold">{t('heading')}</h3>
      <p role="status">{t(`status.${comparison.status}`)}</p>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t('open')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="flex max-h-[90dvh] w-[min(95vw,1100px)] max-w-[1100px] flex-col gap-3 overflow-hidden p-5">
          <div className="flex shrink-0 flex-col gap-3 pr-8">
            <DialogTitle>{t('heading')}</DialogTitle>
            <DialogDescription>{t('hint')}</DialogDescription>
            <p role="status" className="text-sm font-medium">
              {t(`status.${comparison.status}`)}
            </p>
          </div>
          <div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-auto px-1 py-1">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span>{t('run', { runId })}</span>
              <span title={comparison.baselineTree}>
                {t('baseline', { tree: comparison.baselineTree.slice(0, 12) })}
              </span>
              <Button size="xs" variant="outline" disabled={busy} onClick={() => void refresh()}>
                {t('refresh')}
              </Button>
            </div>
            <fieldset
              className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-3"
              disabled={busy || Boolean(pending)}
            >
              <legend className="mb-2 text-sm font-medium">{t('choose')}</legend>
              {comparison.candidates.map((item, index) => (
                <label
                  key={item.candidateId}
                  className="flex min-w-0 cursor-pointer flex-col gap-3 rounded-lg fill-group p-3 text-xs has-[:checked]:ring-1 has-[:checked]:ring-accent"
                >
                  <span className="flex items-start gap-2">
                    <input
                      className="mt-1"
                      type="radio"
                      name={`candidate-${runId}`}
                      value={item.candidateId}
                      checked={selected === item.candidateId}
                      onChange={() => {
                        setSelected(item.candidateId);
                        setError('');
                      }}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">
                        {t('candidate', { number: index + 1 })}
                      </span>
                      <span className="block text-muted wrap-anywhere">{item.modelProfile}</span>
                    </span>
                  </span>
                  <span>
                    {t(`state.${item.state}`)}
                    {comparison.selectedCandidateId === item.candidateId ? ` · ${t('chosen')}` : ''}
                  </span>
                  <span className="grid grid-cols-2 gap-3">
                    <span className="flex flex-col gap-1">
                      <span className="text-lg font-semibold tabular-nums">
                        {item.usage.modelCalls}
                      </span>
                      <span className="text-muted">{t('modelCalls')}</span>
                    </span>
                    <span className="flex flex-col gap-1">
                      <span className="text-lg font-semibold tabular-nums">
                        {item.usage.outputTokens}
                      </span>
                      <span className="text-muted">{t('outputTokens')}</span>
                    </span>
                  </span>
                  <span>
                    {t('checks', {
                      passed: item.checks.filter(
                        (check) => check.verdict === 'pass' && check.state === 'completed',
                      ).length,
                      count: item.checks.length,
                    })}
                  </span>
                  {item.usage.unknownOutputTokens > 0 ? (
                    <span className="text-muted">
                      {t('unknownUsage', { tokens: item.usage.unknownOutputTokens })}
                    </span>
                  ) : null}
                  {item.reason ? (
                    <span className="text-danger wrap-anywhere">
                      {item.reason === 'candidate_execution_failed'
                        ? t('executionFailed')
                        : item.reason === 'completion_budget_reserved'
                          ? t('budgetReserved')
                          : item.reason}
                    </span>
                  ) : null}
                </label>
              ))}
            </fieldset>
            {candidate ? (
              <>
                {candidate.checks.map((check) => (
                  <details key={check.verificationId} className="text-xs">
                    <summary>
                      {check.commandId} ·{' '}
                      {t(`check.${check.state === 'completed' ? check.verdict : check.state}`)}
                    </summary>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded fill-group p-2">
                      {check.output.text || t('noCheckOutput')}
                    </pre>
                  </details>
                ))}
                {changes ? (
                  changes.files.length ? (
                    <>
                      <label className="flex flex-col gap-1 text-xs">
                        {t('file')}
                        <select
                          aria-label={t('file')}
                          value={path}
                          className="rounded fill-control px-2 py-1"
                          onChange={(event) => setPath(event.target.value)}
                        >
                          {changes.files.map((file) => (
                            <option key={file.path} value={file.path}>
                              {file.path}
                            </option>
                          ))}
                        </select>
                      </label>
                      {path ? renderFile(candidate, path) : null}
                    </>
                  ) : (
                    <p className="text-xs text-muted">{t('noChanges')}</p>
                  )
                ) : (
                  <p className="text-xs text-muted">{tree ? t('loading') : t('notReady')}</p>
                )}
              </>
            ) : null}
          </div>
          {candidate || pending || receipt || error ? (
            <div className="flex shrink-0 flex-col gap-2 border-t border-line pt-3">
              {candidate ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={
                      busy ||
                      Boolean(pending) ||
                      !selectable ||
                      candidate.state !== 'acceptable' ||
                      !tree ||
                      changes?.to !== tree
                    }
                    onClick={() => void act('select_candidate')}
                  >
                    {t('apply')}
                  </Button>
                  {candidate.state === 'pending' || candidate.state === 'running' ? (
                    <Button
                      size="sm"
                      variant="ghost-destructive"
                      disabled={busy || Boolean(pending)}
                      onClick={() => void act('cancel_candidate')}
                    >
                      {t('cancel')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {pending ? (
                <div role="status" className="flex flex-wrap items-center gap-2 text-xs">
                  <span>{t('pending')}</span>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void recover()}
                  >
                    {t('recover')}
                  </Button>
                </div>
              ) : null}
              {receipt &&
              !(
                comparison.status === 'selected' && ['accepted', 'queued'].includes(receipt.status)
              ) ? (
                <p role="status" className="text-xs">
                  {t(`receipt.${receipt.status}`)}
                </p>
              ) : null}
              {error ? (
                <p
                  role="alert"
                  className="max-h-24 overflow-auto wrap-anywhere text-sm text-danger"
                >
                  {error}
                </p>
              ) : null}
            </div>
          ) : null}
        </DialogPopup>
      </Dialog>
    </section>
  );
}
