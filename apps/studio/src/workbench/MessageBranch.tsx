import type { MessageBranchPreview } from '@corral/contracts';
import {
  Button,
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@corral/react/design-kit';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { projectsChanged } from '../projects.ts';
import { useServices } from '../services.tsx';
import { newCommandId } from '../sessionActions.ts';

export function MessageBranch({
  runId,
  artifactVersionId,
  requestStart,
  disabled,
}: {
  runId: string;
  artifactVersionId?: string;
  requestStart?: true;
  disabled: boolean;
}) {
  const t = useTranslations('MessageBranch');
  const { workspaces, mode } = useServices();
  const navigate = useNavigate(),
    router = useRouter();
  const [open, setOpen] = useState(false),
    [contextOnly, setContextOnly] = useState(false),
    [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<MessageBranchPreview | null>(null),
    [error, setError] = useState<string | null>(null);
  const [siblings, setSiblings] = useState<
    { sessionId: string; runId: string | null; title: string }[]
  >([]);
  const command = useRef<{ hash: string; id: string } | null>(null);
  useEffect(() => {
    if (!open || !workspaces) return;
    let current = true;
    setPreview(null);
    setError(null);
    void workspaces
      .branchPreview({
        sourceRunId: runId,
        ...(requestStart ? { requestStart: true } : { artifactVersionId: artifactVersionId! }),
        contextOnly,
      })
      .then((value) => {
        if (current) setPreview(value);
      })
      .catch(() => {
        if (current) setError(t('unavailable'));
      });
    void workspaces
      .messageBranches(runId, artifactVersionId ?? 'request_start')
      .then((value) => {
        if (current) setSiblings(value);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [open, runId, artifactVersionId, requestStart, contextOnly, workspaces, t]);
  if (mode !== 'server') return null;
  return (
    <>
      <Button size="compact" variant="ghost" disabled={disabled} onClick={() => setOpen(true)}>
        {t(requestStart ? 'requestOpen' : 'open')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{t(requestStart ? 'requestOpen' : 'open')}</DialogTitle>
            <DialogDescription>
              {t(requestStart ? 'requestDescription' : 'description')}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3 text-sm">
            <label>
              <input
                type="checkbox"
                checked={contextOnly}
                disabled={busy}
                onChange={(event) => setContextOnly(event.target.checked)}
              />{' '}
              {t('contextOnly')}
            </label>
            {preview ? (
              <>
                <p>{t(requestStart ? 'requestBoundary' : preview.kind)}</p>
                <p>{t('point', { sequence: preview.sourceSeq })}</p>
                <p>
                  {preview.tree ? t('tree', { tree: preview.tree.slice(0, 12) }) : t('noFiles')}
                </p>
                <p>
                  {t('budget', {
                    model: preview.modelProfile,
                    calls: preview.limits.maxModelCalls,
                    tokens: preview.limits.maxOutputTokens,
                  })}
                </p>
                <Button
                  disabled={busy}
                  onClick={() => {
                    if (!workspaces) return;
                    if (command.current?.hash !== preview.hash)
                      command.current = { hash: preview.hash, id: newCommandId() };
                    setBusy(true);
                    setError(null);
                    void workspaces
                      .branchMessage({
                        sourceRunId: runId,
                        ...(requestStart
                          ? { requestStart: true as const }
                          : { artifactVersionId: artifactVersionId! }),
                        contextOnly,
                        expectedHash: preview.hash,
                        commandId: command.current.id,
                      })
                      .then(async (result) => {
                        if (!result.runId || !result.sessionId)
                          throw new Error(result.receipt.error?.message ?? t('unavailable'));
                        projectsChanged();
                        await router.invalidate();
                        setOpen(false);
                        await navigate({
                          to: '/sessions/$sessionId',
                          params: { sessionId: result.sessionId },
                          search: { panel: 'run', run: result.runId, view: 'run' },
                        });
                      })
                      .catch((failure) =>
                        setError(failure instanceof Error ? failure.message : t('unavailable')),
                      )
                      .finally(() => setBusy(false));
                  }}
                >
                  {t('start')}
                </Button>
              </>
            ) : null}
            {siblings.length ? (
              <div>
                <p className="font-medium">{t('siblings')}</p>
                <ul>
                  {siblings.map((item) => (
                    <li key={item.sessionId}>
                      <Link
                        to="/sessions/$sessionId"
                        params={{ sessionId: item.sessionId }}
                        search={item.runId ? { panel: 'run', run: item.runId, view: 'run' } : {}}
                        className="underline"
                      >
                        {item.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="text-danger">
                {error}
              </p>
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}
