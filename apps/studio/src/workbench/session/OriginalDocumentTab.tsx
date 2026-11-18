// A 문서 tab of the project's source folder (features/session-panel.md 문서 탭, workbench.md 파일과
// 문서 탭): the file read-only, as the folder holds it. It reads the file itself and keeps no
// buffer, editor model or draft; its more menu references lines into the conversation's input.
import type { FileSideView } from '@corral/client';
import { Button, Menu, MenuItem, MenuPopup, MenuTrigger, Tooltip } from '@corral/react/design-kit';
import { Ellipsis } from '@corral/react/icons';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../../services.tsx';
import { DocumentHeader } from '../DocumentHeader.tsx';
import type { FileReference } from '../FilePanel.tsx';
import { LineRangePopover } from '../LineRangePopover.tsx';
import { onSourceReread } from './sourceReread.ts';

const SourceCode = lazy(() =>
  import('../PierreCode.tsx').then((module) => ({ default: module.SourceCode })),
);

export function OriginalDocumentTab({
  projectId,
  sessionId,
  path,
  onReference,
}: {
  projectId: string;
  /** The conversation whose tree the head may be beside: it names the source only if the tree's differs. */
  sessionId: string;
  path: string;
  onReference: (reference: FileReference) => void;
}) {
  const t = useTranslations('Desktop');
  const tf = useTranslations('Files');
  const te = useTranslations('Documents');
  const { workspaces } = useServices();
  const [read, setRead] = useState<{
    path: string;
    content: FileSideView | null;
    failed: string | null;
  }>({ path, content: null, failed: null });
  const [range, setRange] = useState({ start: 1, end: 1 });
  const [referenceOpen, setReferenceOpen] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  // The conversation's tree refreshed: the file is read again (sourceReread.ts).
  const [again, readAgain] = useState(0);
  useEffect(() => onSourceReread(sessionId, () => readAgain((n) => n + 1)), [sessionId]);
  useEffect(() => {
    void again;
    if (!workspaces) return;
    let live = true;
    void workspaces.readFile({ kind: 'project', id: projectId }, path).then(
      (file) => {
        if (live) setRead({ path, content: file.content, failed: null });
      },
      (failure: unknown) => {
        if (live)
          setRead({
            path,
            content: null,
            failed: failure instanceof Error ? failure.message : String(failure),
          });
      },
    );
    return () => {
      live = false;
    };
  }, [workspaces, projectId, path, again]);
  const content = read.path === path ? read.content : null;
  const failed = read.path === path ? read.failed : null;
  const lineCount = content?.kind === 'text' ? content.text.split('\n').length : 1;
  return (
    <section aria-label={path} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <DocumentHeader
        path={path}
        target={{ kind: 'source', sessionId }}
        status={<span className="truncate @max-xl/head:sr-only">{tf('readOnlyPreview')}</span>}
        actions={
          content?.kind === 'text' ? (
            <Menu>
              <Tooltip content={te('moreActions', { path })}>
                <MenuTrigger
                  ref={more}
                  render={
                    <Button variant="ghost" size="icon" aria-label={te('moreActions', { path })} />
                  }
                >
                  <Ellipsis />
                </MenuTrigger>
              </Tooltip>
              <MenuPopup align="end" className="min-w-48">
                <MenuItem onClick={() => requestAnimationFrame(() => setReferenceOpen(true))}>
                  {te('referenceLinesMenu')}
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : null
        }
      />
      {failed ? (
        <p role="alert" className="px-3 py-2 text-caption text-danger">
          {failed}
        </p>
      ) : null}
      {!content && !failed ? (
        <p role="status" className="px-3 py-2 text-caption text-muted-foreground">
          {t('loadingFile')}
        </p>
      ) : null}
      {content?.kind === 'text' ? (
        <>
          <section aria-label={t('fileContent')} className="min-h-0 flex-1 overflow-auto">
            <Suspense
              fallback={
                <p className="p-3 text-caption text-muted-foreground">{t('loadingFile')}</p>
              }
            >
              <SourceCode path={path} text={content.text} onSelect={setRange} />
            </Suspense>
          </section>
          <LineRangePopover
            open={referenceOpen}
            onOpenChange={setReferenceOpen}
            anchor={more}
            action={t('referenceLines')}
            range={range}
            lineCount={lineCount}
            onRange={setRange}
            note={t('referencePermission')}
            onSubmit={(value) => {
              onReference({ path, ...value });
              setReferenceOpen(false);
            }}
          />
        </>
      ) : content ? (
        <p className="px-3 py-2 text-caption text-muted-foreground">
          {content.kind === 'too_large'
            ? tf('tooLarge')
            : content.kind === 'binary'
              ? tf('binary')
              : t('fileUnavailable')}
        </p>
      ) : null}
    </section>
  );
}
