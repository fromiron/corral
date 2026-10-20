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
  shortcuts(
    bindings: Partial<
      Record<string, { key: string; mod?: boolean; shift?: boolean; alt?: boolean }>
    >,
  ): Promise<void>;
  revealWorkspace(): Promise<void>;
  openExternal(url: string): Promise<void>;
  openPreview(sessionId: string, leaseId: string): Promise<void>;
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
    corralRemote?: {
      readonly hostId: string;
      openPreview(sessionId: string, leaseId: string): Promise<void>;
    };
  }
}
export const desktop = typeof window === 'undefined' ? undefined : window.corralDesktop;
/** Remote hosts expose only host-scoped preview, never local filesystem/window capabilities. */
export const previewDesktop =
  typeof window === 'undefined' ? undefined : (window.corralDesktop ?? window.corralRemote);

/**
 * Double-clicking the empty top bar maximizes or restores the window, as a system title bar
 * does (CR-017). The system draws the window buttons themselves over the bar.
 */
export function onTopbarDoubleClick(event: { target: EventTarget; currentTarget: EventTarget }) {
  if (desktop && event.target === event.currentTarget) void desktop.window('maximize');
}

export function DesktopWorkspace() {
  const t = useTranslations('Desktop');
  const [error, setError] = useState<string | null>(null);
  if (!desktop) return null;
  const act = (operation: () => Promise<void>) => {
    setError(null);
    void operation().catch(() => setError(t('desktopUnavailable')));
  };
  return (
    <section className="settings-row">
      <div>
        <h3>{t('openWorkspace')}</h3>
        <p>{t('appWorkspaceHint')}</p>
        <p>{t('switchWorkspaceHint')}</p>
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : null}
      </div>
      <Button variant="outline" onClick={() => act(() => desktop.openWorkspace())}>
        <FolderOpen />
        {t('openWorkspace')}
      </Button>
    </section>
  );
}

export function DesktopAbout({ serverVersion }: { serverVersion?: string }) {
  const t = useTranslations('Desktop');
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (desktop) void desktop.info().then(setInfo, () => setError(true));
  }, []);
  const version = info
    ? `Corral ${info.version} · ${info.platform} · Node ${info.node}`
    : serverVersion
      ? t('serverVersion', { version: serverVersion })
      : null;
  const reveal = () => {
    setError(false);
    void desktop?.revealWorkspace().catch(() => setError(true));
  };
  return (
    <>
      {version ? (
        <section className="settings-row">
          <div>
            <h3>{t('version')}</h3>
            <p>{version}</p>
            {info && !info.gitAvailable ? (
              <p role="status" className="text-warning">
                {t('gitMissing')}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}
      {info ? (
        <section className="settings-row">
          <div>
            <h3>{t('appWorkspace')}</h3>
            <p className="break-all">{info.workspace}</p>
          </div>
          <Button variant="outline" onClick={reveal}>
            {t('revealWorkspace')}
          </Button>
        </section>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {t('desktopUnavailable')}
        </p>
      ) : null}
    </>
  );
}
