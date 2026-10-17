import type { FileSideView } from '@corral/client';
import { FileText, RefreshCw, X } from '@corral/react/icons';
import { Button, Input, Select } from '@corral/react/ui';
import { Link } from '@tanstack/react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useRemembered } from '../pages/Workbench.tsx';
import { useServices } from '../services.tsx';
import { useWorkspaceFiles } from './useWorkspaceFiles.ts';

const SourceCode = lazy(() =>
  import('./PierreCode.tsx').then((module) => ({ default: module.SourceCode })),
);

export interface FileReference {
  path: string;
  start: number;
  end: number;
}
export const referenceText = ({ path, start, end }: FileReference) =>
  `@${path.includes(' ') ? JSON.stringify(path) : path}:L${start}${end === start ? '' : `-L${end}`}`;

export function FilePanel({
  projectId,
  sessionId,
  onReference,
}: {
  projectId: string;
  sessionId: string;
  onReference: (reference: FileReference) => void;
}) {
  const t = useTranslations('Desktop');
  const tf = useTranslations('Files');
  const { workspaces } = useServices();
  const [savedSource, setSource] = useRemembered<'project' | 'session' | null>(
    `corral:file-source:v1:${sessionId}`,
    null,
  );
  const source = savedSource === 'project' || savedSource === 'session' ? savedSource : undefined;
  const { scope, list, hasCopy, loading, error, refresh } = useWorkspaceFiles(
    projectId,
    sessionId,
    source,
  );
  const [saved, save] = useRemembered<{ paths: string[]; active: string | null }>(
    `corral:file-tabs:v1:${sessionId}:${scope?.kind ?? 'project'}`,
    { paths: [], active: null },
  );
  const paths = Array.isArray(saved?.paths)
    ? saved.paths.filter((p): p is string => typeof p === 'string').slice(0, 20)
    : [];
  const active =
    typeof saved?.active === 'string' && paths.includes(saved.active) ? saved.active : null;
  const [query, setQuery] = useState('');
  const [content, setContent] = useState<FileSideView | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [range, setRange] = useState({ start: 1, end: 1 });
  const files = list.files.filter((f) => f.path.toLowerCase().includes(query.toLowerCase()));
  const scroll = useRef<HTMLDivElement>(null);
  const rows = useVirtualizer({
    count: files.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 30,
    overscan: 6,
  });
  const open = (path: string) =>
    save({ paths: paths.includes(path) ? paths : [...paths.slice(-19), path], active: path });
  const close = (path: string) => {
    const next = paths.filter((p) => p !== path);
    save({ paths: next, active: active === path ? (next.at(-1) ?? null) : active });
  };
  const scopeKind = scope?.kind;
  const scopeId = scope?.id;
  useEffect(() => {
    // A refreshed listing also invalidates the open file's content.
    void list;
    setContent(null);
    setReadError(null);
    setRange({ start: 1, end: 1 });
    if (!active || !scopeKind || !scopeId || !workspaces) return;
    let live = true;
    void workspaces.readFile({ kind: scopeKind, id: scopeId }, active).then(
      (file) => {
        if (live) setContent(file.content);
      },
      (failure: unknown) => {
        if (live) setReadError(failure instanceof Error ? failure.message : String(failure));
      },
    );
    return () => {
      live = false;
    };
  }, [workspaces, active, scopeKind, scopeId, list]);
  if (!scope && !loading)
    return (
      <div className="space-y-2 p-3 text-xs text-muted">
        {error ? <p role="alert">{error}</p> : <p>{t('linkToBrowse')}</p>}
        <Link to="/settings" search={{ section: 'workspace' }} className="text-accent underline">
          {t('workspace')}
        </Link>
      </div>
    );
  const lineCount = content?.kind === 'text' ? content.text.split('\n').length : 1;
  return (
    <div className="flex min-h-0 flex-col gap-2" data-testid="file-panel">
      <div className="flex items-center gap-2">
        <Select
          label={t('fileSource')}
          size="xs"
          variant="ghost"
          className="min-w-0 flex-1 justify-start"
          value={scopeKind ?? 'project'}
          onValueChange={setSource}
          options={[
            { value: 'project' as const, label: t('sourceFolder') },
            ...(hasCopy ? [{ value: 'session' as const, label: t('sessionCopy') }] : []),
          ]}
        />
        <Button size="icon-xs" variant="ghost" aria-label={t('refreshFiles')} onClick={refresh}>
          <RefreshCw />
        </Button>
      </div>
      <Input
        aria-label={t('filterFiles')}
        placeholder={t('filterFiles')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div ref={scroll} className="h-44 overflow-auto">
        <div style={{ height: rows.getTotalSize(), position: 'relative' }}>
          {rows.getVirtualItems().map((row) => {
            const file = files[row.index];
            if (!file) return null;
            return (
              <button
                key={file.path}
                type="button"
                aria-label={t('openFile', { path: file.path })}
                title={file.path}
                onClick={() => open(file.path)}
                style={{
                  position: 'absolute',
                  top: row.start,
                  left: 0,
                  width: '100%',
                  height: row.size,
                }}
                className={`flex items-center gap-2 rounded px-2 text-left text-xs hover:bg-raised ${active === file.path ? 'bg-sidebar-selected' : ''}`}
              >
                <FileText size={14} className="shrink-0 text-muted" />
                <span className="truncate">{file.path}</span>
              </button>
            );
          })}
        </div>
        {!loading && !files.length ? (
          <p className="p-2 text-xs text-muted">{t('noFiles')}</p>
        ) : null}
      </div>
      {list.truncated ? (
        <p role="note" className="text-xs text-muted">
          {t('filesTruncated')}
        </p>
      ) : null}
      <div
        role="tablist"
        aria-label={t('openFiles')}
        className="flex overflow-x-auto border-b border-line"
      >
        {paths.map((path) => (
          <div
            key={path}
            className={`flex shrink-0 items-center border-r border-line ${active === path ? 'bg-raised' : ''}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active === path}
              tabIndex={active === path ? 0 : -1}
              onClick={() => open(path)}
              onKeyDown={(event) => {
                const index = paths.indexOf(path);
                const next =
                  event.key === 'ArrowRight'
                    ? (index + 1) % paths.length
                    : event.key === 'ArrowLeft'
                      ? (index + paths.length - 1) % paths.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? paths.length - 1
                          : -1;
                const nextPath = paths[next];
                if (nextPath === undefined) return;
                event.preventDefault();
                open(nextPath);
                event.currentTarget
                  .closest('[role="tablist"]')
                  ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  [next]?.focus();
              }}
              className="max-w-40 truncate px-2 py-2 text-xs"
              title={path}
            >
              {path}
            </button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={t('closeFile', { path })}
              onClick={() => close(path)}
            >
              <X />
            </Button>
          </div>
        ))}
      </div>
      {readError ? (
        <p role="alert" className="text-xs text-danger">
          {readError}
        </p>
      ) : null}
      {active && !content && !readError ? (
        <p className="text-xs text-muted">{t('loadingFile')}</p>
      ) : null}
      {content?.kind === 'text' && active ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label>
              {t('fromLine')}{' '}
              <input
                type="number"
                min={1}
                max={lineCount}
                value={range.start}
                onChange={(e) => setRange((r) => ({ ...r, start: e.target.valueAsNumber || 1 }))}
                className="w-14 rounded border border-line bg-surface px-1"
              />
            </label>
            <label>
              {t('toLine')}{' '}
              <input
                type="number"
                min={range.start}
                max={lineCount}
                value={range.end}
                onChange={(e) => setRange((r) => ({ ...r, end: e.target.valueAsNumber || 1 }))}
                className="w-14 rounded border border-line bg-surface px-1"
              />
            </label>
            <Button
              size="xs"
              variant="outline"
              disabled={range.start < 1 || range.end < range.start || range.end > lineCount}
              onClick={() => onReference({ path: active, ...range })}
            >
              {t('referenceLines')}
            </Button>
          </div>
          <section
            aria-label={t('fileContent')}
            className="max-h-[45vh] overflow-auto rounded border border-line bg-surface"
          >
            <Suspense fallback={<p className="p-3 text-xs text-muted">{t('loadingFile')}</p>}>
              <SourceCode path={active} text={content.text} onSelect={setRange} />
            </Suspense>
          </section>
          <p className="text-2xs text-muted">{t('referencePermission')}</p>
        </>
      ) : content ? (
        <p className="text-xs text-muted">
          {content.kind === 'too_large'
            ? tf('tooLarge')
            : content.kind === 'binary'
              ? tf('binary')
              : t('fileUnavailable')}
        </p>
      ) : null}
    </div>
  );
}
