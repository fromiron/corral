import type { WorkspacePreview } from '@corral/client';
import { Button, InputCopy } from '@corral/react/design-kit';
import { RefreshCw } from '@corral/react/icons';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';

const OUTPUT_LIMIT = 16 * 1024;
const VIEWPORTS = { full: null, tablet: 768, mobile: 390 } as const;
type Viewport = keyof typeof VIEWPORTS;
const viewportLabel = {
  full: 'viewportFull',
  tablet: 'viewportTablet',
  mobile: 'viewportMobile',
} as const;

/** The operation behind a preview, whose output the person may read. */
export interface PreviewOutput {
  kind: 'task' | 'command';
  operationId: string;
}

/**
 * The address people can copy: origin and path only. The lease URL's query, fragment and any
 * credentials carry the preview capability and stay out of the page.
 */
export function previewAddress(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '';
  }
}

/**
 * An open preview: its address, and its linked task's recent output on request. An inline frame
 * (a static preview in the browser) also gets Refresh and viewport sizes, which only reload or
 * resize that frame: neither touches the lease or the task. The frame stays sandboxed with no
 * permissions; interactive previews keep opening in the desktop app's own window.
 */
export function PreviewView({
  sessionId,
  lease,
  output,
  inline = false,
}: {
  sessionId: string;
  lease: WorkspacePreview;
  output: PreviewOutput | null;
  inline?: boolean;
}) {
  const t = useTranslations('Preview');
  const [viewport, setViewport] = useState<Viewport>('full');
  const [revision, reload] = useState(0);
  const address = previewAddress(lease.url);
  const width = VIEWPORTS[viewport];
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {address ? (
          <InputCopy
            value={address}
            className="min-w-0 flex-[1_1_12rem]"
            title={`${t('address')}: ${address}`}
            labels={{
              copy: t('copy'),
              copied: t('copied'),
              failed: t('copyFailedShort'),
              copyFailed: t('copyFailed'),
              copyToClipboard: t('copyAddress'),
            }}
          />
        ) : null}
        {inline ? (
          <>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t('refresh')}
              onClick={() => reload((value) => value + 1)}
            >
              <RefreshCw />
            </Button>
            <fieldset className="flex items-center gap-1">
              <legend className="sr-only">{t('viewport')}</legend>
              {(Object.keys(VIEWPORTS) as Viewport[]).map((size) => (
                <Button
                  key={size}
                  variant={viewport === size ? 'secondary' : 'ghost'}
                  aria-pressed={viewport === size}
                  onClick={() => setViewport(size)}
                >
                  {t(viewportLabel[size])}
                </Button>
              ))}
            </fieldset>
          </>
        ) : null}
      </div>
      {inline ? (
        <div className="min-w-0 overflow-x-auto">
          <iframe
            // A new key reloads the frame; a viewport change only resizes it.
            key={`${lease.leaseId}:${revision}`}
            title={t('title')}
            src={lease.url}
            sandbox=""
            referrerPolicy="no-referrer"
            style={{
              width: width === null ? '100%' : `${width}px`,
              colorScheme: 'light',
              backgroundColor: 'Canvas',
            }}
            className="mx-auto block h-[45vh] min-h-64 rounded border border-line"
          />
        </div>
      ) : null}
      {output ? <RecentOutput sessionId={sessionId} output={output} /> : null}
    </div>
  );
}

/** Read only while open; a closed disclosure asks the server nothing. */
function RecentOutput({ sessionId, output }: { sessionId: string; output: PreviewOutput }) {
  const t = useTranslations('Preview');
  const { workspaces } = useServices();
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<{ id: string; text: string; read: boolean } | null>(null);
  const id = `${output.kind}:${output.operationId}`;
  useEffect(() => {
    if (!open || !workspaces) return;
    let live = true;
    let reading = false;
    let offset = 0;
    let text = '';
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const chunk =
          output.kind === 'task'
            ? await workspaces.taskOutput(sessionId, output.operationId, offset)
            : await workspaces.commandOutput(sessionId, output.operationId, offset);
        if (!live) return;
        offset = chunk.nextOffset;
        text = (text + chunk.text).slice(-OUTPUT_LIMIT);
        setLog({ id, text, read: true });
      } catch {
        if (live && !text) setLog({ id, text: '', read: true });
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [open, workspaces, sessionId, output.kind, output.operationId, id]);
  const shown = log?.id === id ? log : null;
  return (
    <details
      className="min-w-0 text-caption"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="py-1">{t('output')}</summary>
      {shown?.text ? (
        <pre
          role="log"
          aria-label={t('output')}
          className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-subtle p-2"
        >
          {shown.text}
        </pre>
      ) : shown?.read ? (
        <p className="mt-1 text-muted-foreground">{t('noOutput')}</p>
      ) : null}
    </details>
  );
}
