import type { WorkspacesApi } from '@corral/client';
import {
  canonicalJson,
  type GitConflict,
  type GitSequenceState,
  type GitWriteCommand,
} from '@corral/contracts';
import { Button, Dialog, DialogDescription, DialogPopup, DialogTitle } from '@corral/react/ui';
import {
  lazy,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslations } from 'use-intl';
import { SourceNavigationContext } from './context/SourceAttachments.tsx';
import type { DocumentBuffer, DocumentStore } from './documents/store.ts';

const FileDiff = lazy(() =>
  import('../pages/ReviewPage.tsx').then((module) => ({ default: module.FileDiff })),
);
export type ConflictStage = Omit<Extract<GitWriteCommand, { kind: 'stage' }>, 'operationId'>;
interface Props {
  api: Pick<WorkspacesApi, 'gitConflict'>;
  owner: DocumentStore;
  state: GitSequenceState;
  writable: boolean;
  disabled: boolean;
  onStage(command: ConflictStage): Promise<void>;
}
const unsafe = (entry: DocumentBuffer) =>
  entry.dirty || entry.saving || entry.pendingSave !== null || entry.conflict !== null;
export function GitConflicts(props: Props) {
  return (
    <Conflicts
      key={canonicalJson([
        props.state.target,
        props.state.head,
        props.state.indexHash,
        props.state.sequence?.identity,
      ])}
      {...props}
    />
  );
}
function Conflicts({ api, owner, state, writable, disabled, onStage }: Props) {
  const t = useTranslations('GitConflicts');
  const navigation = useContext(SourceNavigationContext);
  const { documents } = useSyncExternalStore(owner.subscribe, owner.getState, owner.getState);
  const scope = canonicalJson(state.target);
  const [open, setOpen] = useState(false),
    [path, setPath] = useState('');
  const [value, setValue] = useState<GitConflict | null>(null);
  const [side, setSide] = useState<'ours' | 'theirs' | 'current'>('current');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const epoch = useRef(0);
  useEffect(
    () => () => {
      ++epoch.current;
    },
    [],
  );
  const matches = (entry: DocumentBuffer) =>
    canonicalJson(entry.target) === scope && entry.path === path;
  const drafts = Object.values(documents).some((entry) => matches(entry) && unsafe(entry));
  const protect = () => {
    if (Object.values(owner.getState().documents).some((entry) => matches(entry) && unsafe(entry)))
      throw new Error(t('drafts'));
  };
  const read = async (selected: string) => {
    const request = {
      target: state.target,
      path: selected,
      head: state.head,
      indexHash: state.indexHash,
      sequenceIdentity: state.sequence?.identity ?? null,
    };
    const result = await api.gitConflict(state.target.sessionId, request);
    if (
      canonicalJson(result.target) !== scope ||
      result.path !== selected ||
      result.head !== request.head ||
      result.indexHash !== request.indexHash ||
      result.sequenceIdentity !== request.sequenceIdentity
    )
      throw new Error(t('stale'));
    return result;
  };
  const select = async (selected: string) => {
    const revision = ++epoch.current;
    setOpen(true);
    setPath(selected);
    setValue(null);
    setSide('current');
    setError('');
    setBusy(true);
    try {
      const result = await read(selected);
      if (revision === epoch.current) setValue(result);
    } catch (failure) {
      if (revision === epoch.current)
        setError(failure instanceof Error ? failure.message : t('failed'));
    } finally {
      if (revision === epoch.current) setBusy(false);
    }
  };
  const close = () => {
    ++epoch.current;
    setOpen(false);
    setBusy(false);
  };
  const edit = async () => {
    if (!value || !navigation || busy) return;
    const revision = ++epoch.current;
    setBusy(true);
    setError('');
    try {
      const key = await owner.open(state.target.sessionId, path);
      if (revision !== epoch.current) return;
      let entry = owner.getState().documents[key];
      if (!entry || !matches(entry)) throw new Error(t('stale'));
      if (!unsafe(entry) && entry.baseHash !== value.currentHash) {
        await owner.refresh(key);
        if (revision !== epoch.current) return;
        entry = owner.getState().documents[key];
        if (!entry || !matches(entry)) throw new Error(t('stale'));
      }
      if (!navigation.openDocument(state.target, path)) throw new Error(t('failed'));
      close();
    } catch (failure) {
      if (revision === epoch.current)
        setError(failure instanceof Error ? failure.message : t('failed'));
    } finally {
      if (revision === epoch.current) setBusy(false);
    }
  };
  const stage = async () => {
    if (!value || busy || disabled || !writable) return;
    const revision = ++epoch.current;
    setBusy(true);
    setError('');
    try {
      protect();
      const fresh = await read(path);
      if (revision !== epoch.current) return;
      if (fresh.currentHash !== value.currentHash || fresh.unsupported) throw new Error(t('stale'));
      protect();
      await onStage({
        kind: 'stage',
        target: state.target,
        expect: { head: state.head, indexHash: state.indexHash },
        paths: [path],
      });
      if (revision === epoch.current) close();
    } catch (failure) {
      if (revision === epoch.current)
        setError(failure instanceof Error ? failure.message : t('failed'));
    } finally {
      if (revision === epoch.current) setBusy(false);
    }
  };
  return (
    <>
      <ul className="flex flex-col gap-0.5">
        {state.conflicts.map((file) => (
          <li key={file}>
            <Button
              variant="ghost"
              size="sm"
              className="max-w-full justify-start font-mono"
              onClick={() => void select(file)}
            >
              <span className="whitespace-pre-wrap break-all">{file}</span>
            </Button>
          </li>
        ))}
      </ul>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogPopup className="flex max-h-[90dvh] w-[min(68rem,96vw)] max-w-none flex-col gap-3 overflow-y-auto p-5">
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
          <p className="shrink-0 whitespace-pre-wrap break-all font-mono text-sm">{path}</p>
          {state.sequence?.kind === 'rebase' ? (
            <p className="shrink-0 text-xs text-muted">{t('rebaseSides')}</p>
          ) : null}
          {value ? (
            <>
              <fieldset
                className="flex shrink-0 flex-wrap items-center gap-2"
                aria-label={t('sides')}
              >
                {(['ours', 'theirs', 'current'] as const).map((item) => (
                  <Button
                    key={item}
                    size="sm"
                    variant={side === item ? 'secondary' : 'ghost'}
                    aria-pressed={side === item}
                    onClick={() => setSide(item)}
                  >
                    {t(item)}
                  </Button>
                ))}
              </fieldset>
              {value.unsupported ? (
                <p role="status" className="text-xs text-warning">
                  {t('unsupported')} · {value.unsupported}
                </p>
              ) : null}
              <Suspense fallback={<p role="status">{t('loading')}</p>}>
                <FileDiff
                  key={`${value.path}:${side}`}
                  path={value.path}
                  loadKey={canonicalJson([value.target, value.indexHash, value.currentHash, side])}
                  load={async () => ({ before: value.base, after: value[side] })}
                />
              </Suspense>
              {drafts ? (
                <p role="status" className="text-xs text-warning">
                  {t('drafts')}
                </p>
              ) : null}
            </>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={close}>
              {t('close')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                !value ||
                busy ||
                !navigation ||
                Boolean(value.unsupported) ||
                value.current.kind !== 'text'
              }
              onClick={() => void edit()}
            >
              {t('openEditor')}
            </Button>
            {writable ? (
              <Button
                size="sm"
                disabled={!value || busy || disabled || drafts || Boolean(value.unsupported)}
                onClick={() => void stage()}
              >
                {t('stage')}
              </Button>
            ) : null}
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
