import { FolderOpen } from '@corral/react/icons';
import { Button } from '@corral/react/ui';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';

interface DesktopInfo {
  version: string;
  platform: string;
  /** The system draws the window buttons over the top bar (CR-017). */
  overlay: boolean;
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
  theme(dark: boolean): Promise<void>;
  notify(title: string, body: string): Promise<boolean>;
  badge(count: number): Promise<void>;
  /** Menu commands by name; returns the unsubscribe function. */
  onCommand(callback: (id: string) => void): () => void;
}
declare global {
  interface Window {
    corralDesktop?: DesktopBridge;
  }
}
export const desktop = typeof window === 'undefined' ? undefined : window.corralDesktop;

/**
 * Double-clicking the empty top bar maximizes or restores the window, as a system title bar
 * does (CR-017). The system draws the window buttons themselves over the bar.
 */
export function onTopbarDoubleClick(event: { target: EventTarget; currentTarget: EventTarget }) {
  if (desktop && event.target === event.currentTarget) void desktop.window('maximize');
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
      <Button size="sm" variant="ghost" onClick={() => act(() => desktop.revealWorkspace())}>
        {t('revealWorkspace')}
      </Button>
      <div className="space-y-3 border-t border-line pt-4">
        <p className="text-xs text-muted">{t('switchWorkspaceHint')}</p>
        <Button size="sm" variant="outline" onClick={() => act(() => desktop.openWorkspace())}>
          <FolderOpen />
          {t('openWorkspace')}
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
