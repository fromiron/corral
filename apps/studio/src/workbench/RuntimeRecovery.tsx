import type { RuntimeCheckpointView } from '@corral/contracts';
import { Button } from '@corral/react/design-kit';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { newCommandId } from '../sessionActions.ts';

export function RuntimeRecovery({ runId, sessionId }: { runId: string; sessionId: string | null }) {
  const t = useTranslations('RuntimeRecovery');
  const { workspaces } = useServices();
  const navigate = useNavigate();
  const router = useRouter();
  const [items, setItems] = useState<RuntimeCheckpointView[] | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const commands = useRef(new Map<string, string>());
  useEffect(() => {
    let current = true;
    void workspaces
      ?.runtimeCheckpoints(runId)
      .then((value) => {
        if (current) setItems(value);
      })
      .catch(() => {
        if (current) setError(t('unavailable'));
      });
    return () => {
      current = false;
    };
  }, [runId, workspaces, t]);
  return (
    <div data-testid="runtime-recovery" className="space-y-2 border-t border-line pt-2">
      <p className="font-medium">{t('title')}</p>
      <p className="text-muted-foreground">{t('scope')}</p>
      {items?.length === 0 ? <p>{t('empty')}</p> : null}
      {items?.map((item) => (
        <div key={item.checkpointId} className="space-y-1">
          <p>
            {item.runtime} · {new Date(item.createdAt).toLocaleString()} ·{' '}
            <code>{item.contextHash.slice(0, 12)}</code>
          </p>
          <p>{t('tree', { tree: item.tree?.slice(0, 12) ?? t('noFiles') })}</p>
          {item.usageLimits === 'none' ? (
            <p>{t('unlimited')}</p>
          ) : item.limits ? (
            <p>
              {t('remaining', {
                calls: item.limits.maxModelCalls,
                tokens: item.limits.maxOutputTokens,
              })}
            </p>
          ) : null}
          {item.blockers.map((blocker) => (
            <p key={blocker}>{t(`blockers.${blocker}`)}</p>
          ))}
          <Button
            size="compact"
            variant="tertiary"
            disabled={!item.ready || busy}
            onClick={() => {
              if (!workspaces) return;
              setBusy(true);
              setError(null);
              let commandId = commands.current.get(item.checkpointId);
              if (!commandId) {
                commandId = newCommandId();
                commands.current.set(item.checkpointId, commandId);
              }
              void workspaces
                .resumeRuntime({
                  commandId,
                  sourceRunId: runId,
                  checkpointId: item.checkpointId,
                  manifestHash: item.manifestHash,
                  expectedSourceSeq: item.sourceSeq,
                })
                .then(async (result) => {
                  if (!result.runId)
                    throw new Error(result.receipt.error?.message ?? t('unavailable'));
                  await router.invalidate();
                  if (sessionId)
                    await navigate({
                      to: '/sessions/$sessionId',
                      params: { sessionId },
                      search: { panel: 'run', run: result.runId, view: 'run' },
                    });
                  else await navigate({ to: '/runs/$runId', params: { runId: result.runId } });
                })
                .catch((failure) =>
                  setError(failure instanceof Error ? failure.message : t('unavailable')),
                )
                .finally(() => setBusy(false));
            }}
          >
            {t('continue')}
          </Button>
        </div>
      ))}
      {error ? (
        <p role="alert" className="text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
