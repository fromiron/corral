import type { PaddockSetup } from '@corral/client';
import { Button } from '@corral/react/design-kit';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';

export type SetupWord = 'setupRunning' | 'setupFailed' | 'setupUncertain';

export function setupWord(setup: PaddockSetup | null | undefined): SetupWord | null {
  if (!setup || setup.state === 'succeeded') return null;
  if (setup.state === 'running') return 'setupRunning';
  if (setup.state === 'uncertain') return 'setupUncertain';
  return 'setupFailed';
}

const TONE: Record<SetupWord, string> = {
  setupRunning: 'shimmer-text text-muted-foreground',
  setupFailed: 'text-destructive',
  setupUncertain: 'text-warning',
};

export function PaddockSetupStatus({
  sessionId,
  setup,
  onChanged,
}: {
  sessionId: string;
  setup: PaddockSetup | null;
  onChanged: () => void;
}) {
  const t = useTranslations('Files');
  const { workspaces } = useServices();
  const [output, setOutput] = useState<{ operationId: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const word = setupWord(setup);
  if (!word || !setup || !workspaces) return null;
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged();
    } catch (failure) {
      setError(
        t('failed', { message: failure instanceof Error ? failure.message : String(failure) }),
      );
    } finally {
      setBusy(false);
    }
  };
  const read = async () => {
    const detail = await workspaces.setup(sessionId, setup.operationId);
    setOutput({ operationId: setup.operationId, text: detail.output.text });
    return detail;
  };
  const live = setup.state === 'running' || setup.state === 'uncertain';
  const shown = output?.operationId === setup.operationId ? output.text : null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <details
          className="min-w-0 flex-1"
          onToggle={(event) => {
            if (event.currentTarget.open) void read().catch(() => {});
          }}
        >
          <summary className="w-fit text-caption">
            <span role="status" className={TONE[word]}>
              {t(word)}
            </span>
          </summary>
          <section
            aria-label={t('setupOutput')}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling output is reached by keyboard
            tabIndex={0}
            className="mt-1 max-h-48 overflow-auto rounded-md fill-group p-2"
          >
            <pre className="m-0 whitespace-pre-wrap font-mono text-caption">
              {shown || t('setupNoOutput')}
            </pre>
          </section>
        </details>
        <Button
          type="button"
          variant="tertiary"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const { target } = await read();
              if (live) await workspaces.stopSetup(sessionId, setup.operationId, target);
              else
                await workspaces.startSetup(sessionId, {
                  operationId: `setup_${crypto.randomUUID().replaceAll('-', '')}`,
                  target,
                });
            })
          }
        >
          {t(live ? 'setupStop' : 'setupAgain')}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="m-0 text-caption text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
