import type { GitWriteCommand, PullRequestDraft, PullRequestView } from '@corral/contracts';
import {
  Button,
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  InputField,
  InputGroup,
  Textarea,
} from '@corral/react/design-kit';
import { ExternalLink, GitPullRequest } from '@corral/react/icons';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { WORKSPACE_CHANGED } from './workspaceEvents.ts';

type Workspaces = NonNullable<ReturnType<typeof useServices>['workspaces']>;
type Opening = Extract<PullRequestView, { kind: 'none' }>['action'] & ('push_and_open' | 'open');

interface DialogState {
  action: Opening;
  controller: AbortController;
  operationId: string;
  draft: PullRequestDraft | null;
  title: string;
  body: string;
  edited: boolean;
  phase: 'drafting' | 'ready' | 'pushing' | 'opening' | 'checking';
  error: string | null;
}

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pushBranch(workspaces: Workspaces, sessionId: string, branch: string) {
  const status = await workspaces.gitStatus({ kind: 'session', id: sessionId });
  if (status.target.kind !== 'session') throw new Error('no working copy');
  const { kind: _kind, ...target } = status.target;
  let operation = await workspaces.gitChange(sessionId, {
    operationId: newId('git'),
    kind: 'push',
    target,
    expect: { head: status.head.oid, indexHash: status.indexHash },
    remote: 'origin',
    branch,
    runHooks: true,
  } as GitWriteCommand);
  for (let i = 0; operation.state === 'running' && i < 240; i++) {
    await wait(500);
    operation = await workspaces.gitOperation(sessionId, operation.operationId);
  }
  window.dispatchEvent(new Event(WORKSPACE_CHANGED));
  if (operation.state !== 'succeeded')
    throw new Error((operation.result as { message?: string } | null)?.message ?? operation.state);
}

export function PullRequestRow({
  sessionId,
  view,
  onSync,
  onChanged,
}: {
  sessionId: string;
  view: PullRequestView | null;
  onSync(): void;
  onChanged(): void;
}) {
  const t = useTranslations('PullRequests');
  const { workspaces } = useServices();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [pushing, setPushing] = useState(false);
  if (!view || view.kind === 'hidden' || !workspaces) return null;

  const begin = (action: Opening) => {
    const controller = new AbortController();
    const operationId = newId('pr');
    setDialog({
      action,
      controller,
      operationId,
      draft: null,
      title: '',
      body: '',
      edited: false,
      phase: 'drafting',
      error: null,
    });
    const mine = (current: DialogState | null) => current?.controller === controller;
    workspaces
      .pullRequestDraft(sessionId, { operationId: newId('pr_draft') }, controller.signal)
      .then(
        (draft) =>
          setDialog((current) =>
            mine(current) && current
              ? {
                  ...current,
                  draft,
                  title: current.edited ? current.title : draft.title,
                  body: current.edited ? current.body : draft.body,
                  phase: current.phase === 'drafting' ? 'ready' : current.phase,
                }
              : current,
          ),
        (failure: unknown) => {
          if (controller.signal.aborted) return;
          setDialog((current) =>
            mine(current) && current
              ? {
                  ...current,
                  phase: 'ready',
                  error: failure instanceof Error ? failure.message : String(failure),
                }
              : current,
          );
        },
      );
  };
  const close = () => {
    dialog?.controller.abort();
    setDialog(null);
  };
  const submit = async () => {
    const current = dialog;
    if (!current?.draft || !current.title.trim()) return;
    const draft = current.draft;
    const step = (phase: DialogState['phase'], error: string | null = null) =>
      setDialog((value) =>
        value?.controller === current.controller ? { ...value, phase, error } : value,
      );
    try {
      if (current.action === 'push_and_open') {
        step('pushing');
        await pushBranch(workspaces, sessionId, draft.head.branch);
      }
      step('opening');
      await workspaces.openPullRequest(sessionId, {
        operationId: current.operationId,
        title: current.title.trim(),
        body: current.body,
        head: draft.head,
      });
      setDialog(null);
      onChanged();
    } catch (failure) {
      const code = (failure as { code?: string }).code;
      if (code === 'REQUEST_OUTCOME_UNKNOWN') {
        step('checking', t('dialog.checking'));
        onChanged();
        return;
      }
      step(
        'ready',
        code === 'REVISION_CONFLICT'
          ? t('dialog.moved')
          : failure instanceof Error
            ? failure.message
            : String(failure),
      );
    }
  };
  const push = async () => {
    if (view.kind !== 'open' || pushing) return;
    setPushing(true);
    try {
      await pushBranch(workspaces, sessionId, view.branch);
    } finally {
      setPushing(false);
      onChanged();
    }
  };

  const summary = view.kind === 'open' ? view.pr : view.kind === 'none' ? view.previous : null;
  const busy = dialog !== null && dialog.phase !== 'ready' && dialog.phase !== 'drafting';
  return (
    <div
      data-pull-request-row=""
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5 text-caption text-muted-foreground"
    >
      {view.kind === 'gh_missing' ? t('ghMissing') : null}
      {view.kind === 'gh_signed_out' ? t('ghSignedOut') : null}
      {view.kind === 'read_failed' ? (
        <>
          <span>{t('readFailed')}</span>
          <Button variant="ghost" onClick={onChanged}>
            {t('retry')}
          </Button>
        </>
      ) : null}
      {summary ? (
        <>
          <span className="inline-flex items-center gap-1.5 text-foreground">
            <GitPullRequest size={14} aria-hidden className="shrink-0" />
            {t('number', { number: summary.number })}
          </span>
          <span>
            {t(
              summary.isDraft && summary.state === 'open'
                ? 'state.draft'
                : `state.${summary.state}`,
            )}
          </span>
          {summary.state === 'open' && summary.checks ? (
            <span className={summary.checks.failed ? 'text-danger' : undefined}>
              {summary.checks.failed
                ? t('checksFailed', { count: summary.checks.failed })
                : summary.checks.pending
                  ? t('checksPending')
                  : t('checksPassed')}
            </span>
          ) : null}
          {summary.state === 'open' && summary.review ? (
            <span>{t(`review.${summary.review}`)}</span>
          ) : null}
          {summary.state === 'open' && summary.conflicting ? (
            <span className="text-danger">{t('conflicting')}</span>
          ) : null}
        </>
      ) : null}
      {view.kind === 'open' && view.push ? (
        <Button variant="tertiary" disabled={pushing} onClick={() => void push()}>
          {t('push')}
        </Button>
      ) : null}
      {view.kind === 'none' && view.action === 'sync' ? (
        <Button variant="tertiary" onClick={onSync}>
          {t('sync')}
        </Button>
      ) : null}
      {view.kind === 'none' && (view.action === 'push_and_open' || view.action === 'open') ? (
        <Button variant="tertiary" onClick={() => begin(view.action as Opening)}>
          {t(view.action === 'push_and_open' ? 'pushAndOpen' : 'open')}
        </Button>
      ) : null}
      {summary ? (
        <a
          href={summary.url}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex items-center gap-1 hover:text-foreground"
        >
          {t('viewOnGitHub')}
          <ExternalLink size={12} aria-hidden />
        </a>
      ) : null}
      <Dialog open={dialog !== null} onOpenChange={(open) => !open && close()}>
        <DialogPopup>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t('dialog.title')}</DialogTitle>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-3">
              {view.kind === 'none' ? (
                <p className="font-mono text-caption text-muted-foreground">
                  {t('dialog.into', { head: view.branch, base: view.base })}
                </p>
              ) : null}
              <InputGroup className="w-full">
                <InputField
                  index={0}
                  label={t('dialog.titleLabel')}
                  id="pull-request-title"
                  name="pull-request-title"
                  value={dialog?.title ?? ''}
                  placeholder={dialog?.phase === 'drafting' ? t('dialog.drafting') : undefined}
                  onChange={(title) =>
                    setDialog((value) => (value ? { ...value, title, edited: true } : value))
                  }
                  maxLength={256}
                  required
                />
              </InputGroup>
              <Textarea
                aria-label={t('dialog.bodyLabel')}
                name="pull-request-body"
                rows={10}
                value={dialog?.body ?? ''}
                placeholder={dialog?.phase === 'drafting' ? t('dialog.drafting') : undefined}
                onChange={(event) => {
                  const body = event.target.value;
                  setDialog((value) => (value ? { ...value, body, edited: true } : value));
                }}
              />
              {dialog?.error ? (
                <p role="alert" className="text-caption text-danger">
                  {dialog.error}
                </p>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              <Button variant="tertiary" type="button" onClick={close}>
                {t('dialog.cancel')}
              </Button>
              <Button type="submit" disabled={!dialog?.draft || !dialog.title.trim() || busy}>
                {t(dialog?.action === 'push_and_open' ? 'dialog.pushAndOpen' : 'dialog.open')}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
