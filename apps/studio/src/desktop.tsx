import { FolderOpen, Maximize2, X } from '@corral/react/icons';
import { Button } from '@corral/react/ui';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';

interface DesktopInfo {
  version: string;
  platform: string;
  status: 'starting' | 'ready' | 'failed';
  gitAvailable: boolean;
  workspace: string;
  node: string;
}
interface DesktopBridge {
  info(): Promise<DesktopInfo>;
  window(action: 'minimize' | 'maximize' | 'close'): Promise<void>;
  pickFolder(): Promise<string | null>;
  openWorkspace(): Promise<void>;
  revealWorkspace(): Promise<void>;
  openExternal(url: string): Promise<void>;
  retry(): Promise<void>;
}
declare global {
  interface Window {
    corralDesktop?: DesktopBridge;
  }
}
export const desktop = typeof window === 'undefined' ? undefined : window.corralDesktop;

export function WindowControls() {
  const t = useTranslations('Desktop');
  if (!desktop) return null;
  return (
    <fieldset
      className="flex h-full shrink-0 items-center border-l border-line/60 pl-1"
      aria-label={t('windowControls')}
    >
      {(['minimize', 'maximize', 'close'] as const).map((action) => (
        <Button
          key={action}
          size="icon-sm"
          variant="ghost"
          aria-label={t(`window.${action}`)}
          title={t(`window.${action}`)}
          onClick={() => void desktop.window(action)}
          className={action === 'close' ? 'hover:bg-danger/20' : ''}
        >
          {action === 'minimize' ? (
            <span aria-hidden="true">−</span>
          ) : action === 'maximize' ? (
            <Maximize2 size={14} />
          ) : (
            <X size={14} />
          )}
        </Button>
      ))}
    </fieldset>
  );
}

export function DesktopWorkspace() {
  const t = useTranslations('Desktop');
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (desktop) void desktop.info().then(setInfo, () => setError(t('desktopUnavailable')));
  }, [t]);
  if (!desktop) return null;
  const act = (operation: () => Promise<void>) => {
    setError(null);
    void operation().catch(() => setError(t('desktopUnavailable')));
  };
  return (
    <section className="space-y-3 rounded-lg border border-line p-4">
      <h3 className="text-sm font-semibold">{t('appWorkspace')}</h3>
      <p className="text-xs text-muted">{t('appWorkspaceHint')}</p>
      {info ? (
        <>
          <p className="text-xs text-muted">
            Corral {info.version} · {info.platform} · Node {info.node}
          </p>
          <details className="text-xs">
            <summary className="cursor-pointer">{t('workspaceLocation')}</summary>
            <code className="mt-2 block break-all">{info.workspace}</code>
          </details>
          {!info.gitAvailable ? (
            <p role="status" className="text-xs text-warning">
              {t('gitMissing')}
            </p>
          ) : null}
        </>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => act(() => desktop.openWorkspace())}>
          <FolderOpen />
          {t('openWorkspace')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => act(() => desktop.revealWorkspace())}>
          {t('revealWorkspace')}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
