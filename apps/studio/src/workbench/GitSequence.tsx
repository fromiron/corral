import {
  canonicalJson,
  type GitAuthor,
  type GitSequenceCommand,
  type GitSequenceState,
  type GitStatus,
} from '@corral/contracts';
import {
  Button,
  Checkbox,
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
  Select,
  Switch,
} from '@corral/react/design-kit';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'use-intl';
import type { DocumentStore } from './documents/store.ts';

type WithoutOperation<T> = T extends unknown ? Omit<T, 'operationId'> : never;
export type GitSequenceInput = WithoutOperation<GitSequenceCommand>;
interface Props {
  sessionId: string;
  status: GitStatus;
  state: GitSequenceState | null;
  owner: DocumentStore;
  disabled: boolean;
  runHooks: boolean;
  author?: GitAuthor;
  onRunHooksChange(value: boolean): void;
  onCommand(command: GitSequenceInput): Promise<void>;
}
type Review = {
  snapshot: string;
  command: GitSequenceInput;
  paths: string[];
  originalHead: string | null;
  branch: string | null;
};

export function GitSequence(props: Props) {
  return (
    <SequenceControls key={canonicalJson([props.sessionId, props.status.target])} {...props} />
  );
}

function SequenceControls({
  sessionId,
  status,
  state,
  owner,
  disabled,
  runHooks,
  author,
  onRunHooksChange,
  onCommand,
}: Props) {
  const t = useTranslations('GitSequence');
  const { documents } = useSyncExternalStore(owner.subscribe, owner.getState, owner.getState);
  const [selected, setSelected] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const { kind: _kind, ...statusTarget } = status.target;
  const matches =
    state &&
    status.target.kind === 'session' &&
    status.target.sessionId === sessionId &&
    canonicalJson(state.target) === canonicalJson(statusTarget) &&
    state.head === status.head.oid &&
    state.indexHash === status.indexHash;
  const snapshot = matches
    ? canonicalJson([state, status.head.branch, status.entries, status.truncated])
    : null;
  const hasDrafts = () =>
    state &&
    Object.values(owner.getState().documents).some(
      (entry) =>
        canonicalJson(entry.target) === canonicalJson(state.target) &&
        (entry.dirty || entry.saving || entry.pendingSave || entry.conflict),
    );
  const drafts =
    state &&
    Object.values(documents).some(
      (entry) =>
        canonicalJson(entry.target) === canonicalJson(state.target) &&
        (entry.dirty || entry.saving || entry.pendingSave || entry.conflict),
    );
  const sequence = state?.sequence;
  const unsupported =
    sequence && (sequence.kind === 'unsupported' || sequence.reason || !state.ownerOperationId);
  const branches =
    state?.localBranches.filter((branch) => branch.name !== status.head.branch) ?? [];
  const branch = branches.find((branch) => branch.name === selected) ?? branches[0];
  const clean =
    !status.entries.length && !status.head.detached && !status.head.unborn && !status.truncated;
  const blocked = disabled || sending || !!drafts || !matches || !!unsupported || status.truncated;
  const prepare = (kind: GitSequenceInput['kind']) => {
    if (blocked || !state || !snapshot || hasDrafts()) return;
    const base = {
      target: { ...state.target },
      expect: { head: state.head, indexHash: state.indexHash },
      sequenceIdentity: sequence?.identity ?? null,
      workingTreeHash: state.workingTreeHash,
    };
    const policy = { runHooks, ...(author?.name && author.email ? { author: { ...author } } : {}) };
    let command: GitSequenceInput;
    if (kind === 'merge' || kind === 'rebase') {
      if (sequence || !clean || !branch) return;
      command = { ...base, ...policy, kind, branch: branch.name, branchCommit: branch.oid };
    } else if (kind === 'continue') {
      if (!sequence || state.conflicts.length) return;
      command = { ...base, ...policy, kind };
    } else {
      if (!sequence) return;
      command = { ...base, kind, confirmed: true };
    }
    setError('');
    setConfirmed(false);
    setReview({
      snapshot,
      command,
      paths: status.entries
        .filter((entry) => entry.kind !== 'untracked')
        .map((entry) => entry.path),
      originalHead: sequence?.originalHead ?? null,
      branch: status.head.branch ?? sequence?.headName ?? null,
    });
  };
  const stale = review && review.snapshot !== snapshot;
  const execute = async () => {
    if (
      !review ||
      blocked ||
      stale ||
      hasDrafts() ||
      (review.command.kind === 'abort' && !confirmed)
    )
      return;
    setSending(true);
    setError('');
    try {
      await onCommand(review.command);
      if (alive.current) setReview(null);
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : t('failed'));
    } finally {
      if (alive.current) setSending(false);
    }
  };
  if (!state)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {t('loading')}
      </p>
    );
  if (!matches)
    return (
      <p role="alert" className="text-xs text-warning">
        {t('changed')}
      </p>
    );
  if (unsupported)
    return (
      <section aria-label={t('title')} className="flex flex-col gap-1 text-xs">
        <p className="font-medium">{t('title')}</p>
        <p role="status" className="text-muted-foreground">
          {sequence?.reason || t(state.ownerOperationId ? 'unsupported' : 'external')}
        </p>
      </section>
    );
  return (
    <section aria-label={t('title')} className="flex flex-col gap-2 text-xs">
      <h3 className="font-medium">{t('title')}</h3>
      {sequence ? (
        <>
          <p role="status">{t(`active.${sequence.kind}`)}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="compact"
              variant="tertiary"
              disabled={blocked || !!state.conflicts.length}
              onClick={() => prepare('continue')}
            >
              {t('reviewContinue')}
            </Button>
            <Button
              size="compact"
              variant="tertiary"
              disabled={blocked}
              onClick={() => prepare('abort')}
            >
              {t('reviewAbort')}
            </Button>
          </div>
          {state.conflicts.length ? (
            <p className="text-muted-foreground">{t('resolveFirst')}</p>
          ) : null}
        </>
      ) : (
        <>
          <Select
            label={t('branch')}
            size="xs"
            value={branch?.name ?? ''}
            onValueChange={setSelected}
            disabled={blocked || !branches.length}
            options={branches.map((value) => ({ value: value.name, label: value.name }))}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="compact"
              variant="tertiary"
              disabled={blocked || !clean || !branch}
              onClick={() => prepare('merge')}
            >
              {t('reviewMerge')}
            </Button>
            <Button
              size="compact"
              variant="tertiary"
              disabled={blocked || !clean || !branch}
              onClick={() => prepare('rebase')}
            >
              {t('reviewRebase')}
            </Button>
          </div>
          {!clean ? (
            <p className="text-muted-foreground">{t('cleanFirst')}</p>
          ) : !branches.length ? (
            <p className="text-muted-foreground">{t('noBranches')}</p>
          ) : null}
        </>
      )}
      <Switch
        label={t('runHooks')}
        checked={runHooks}
        disabled={disabled || sending}
        onToggle={() => onRunHooksChange(!runHooks)}
      />
      {drafts ? (
        <p role="alert" className="text-warning">
          {t('drafts')}
        </p>
      ) : null}
      {status.truncated ? (
        <p role="alert" className="text-warning">
          {t('incomplete')}
        </p>
      ) : null}
      <Dialog
        open={!!review}
        onOpenChange={(open) => {
          if (!open && !sending) setReview(null);
        }}
      >
        <DialogPopup
          showCloseButton={false}
          className="flex max-w-xl flex-col gap-3 overflow-auto p-5"
        >
          <DialogTitle>{t(`review.${review?.command.kind ?? 'merge'}`)}</DialogTitle>
          <DialogDescription>{t(`hint.${review?.command.kind ?? 'merge'}`)}</DialogDescription>
          {review ? (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt>{t('currentBranch')}</dt>
                <dd className="break-all font-mono">{review.branch ?? '—'}</dd>
                <dt>HEAD</dt>
                <dd className="break-all font-mono">{review.command.expect.head ?? '—'}</dd>
                {'branch' in review.command ? (
                  <>
                    <dt>{t('branch')}</dt>
                    <dd className="break-all font-mono">
                      {review.command.branch} · {review.command.branchCommit}
                    </dd>
                  </>
                ) : null}
                {review.command.kind === 'abort' ? (
                  <>
                    <dt>{t('restoreHead')}</dt>
                    <dd className="break-all font-mono">{review.originalHead ?? t('unknown')}</dd>
                  </>
                ) : (
                  <>
                    <dt>{t('runHooks')}</dt>
                    <dd>{t(review.command.runHooks ? 'enabled' : 'disabled')}</dd>
                    <dt>{t('author')}</dt>
                    <dd className="break-all">
                      {review.command.author
                        ? `${review.command.author.name} <${review.command.author.email}>`
                        : t('configuredAuthor')}
                    </dd>
                  </>
                )}
              </dl>
              {review.command.kind === 'abort' ? (
                <>
                  <p className="text-sm text-warning">{t('abortLoss')}</p>
                  <ul
                    aria-label={t('affected')}
                    className="max-h-40 overflow-auto font-mono text-xs"
                  >
                    {review.paths.map((path) => (
                      <li key={path} className="break-all">
                        {path}
                      </li>
                    ))}
                  </ul>
                  <Checkbox
                    label={t('abortConfirm')}
                    checked={confirmed}
                    disabled={sending}
                    onToggle={() => setConfirmed(!confirmed)}
                  />
                </>
              ) : (
                <p className="text-xs text-muted-foreground">{t('signing')}</p>
              )}
              {stale ? (
                <p role="alert" className="text-sm text-warning">
                  {t('changed')}
                </p>
              ) : null}
              {drafts ? (
                <p role="alert" className="text-sm text-warning">
                  {t('drafts')}
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              ) : null}
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" disabled={sending} onClick={() => setReview(null)}>
                  {t('cancel')}
                </Button>
                <Button
                  disabled={blocked || !!stale || (review.command.kind === 'abort' && !confirmed)}
                  onClick={() => void execute()}
                >
                  {t(sending ? 'sending' : 'confirm')}
                </Button>
              </div>
            </>
          ) : null}
        </DialogPopup>
      </Dialog>
    </section>
  );
}
