import type { WorkspacesApi } from '@corral/client';
import type {
  ContentSearchMatch,
  ContentSearchResult,
  TextRange,
  WorkspaceTarget,
} from '@corral/contracts';
import { Button, Input } from '@corral/react/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { DocumentStore } from './documents/store.ts';
import type { OpenDocumentRequest } from './FilePanel.tsx';

const targetKey = (target: WorkspaceTarget) =>
  JSON.stringify([
    target.hostId,
    target.projectId,
    target.bindingId,
    target.sessionId,
    target.copyGeneration,
  ]);

/** Search only saved bytes. Opening a result never substitutes a disk result for a draft. */
export function ContentSearch({
  api,
  owner,
  target,
  onOpenDocument,
  modeControl,
}: {
  api: Pick<WorkspacesApi, 'searchContents' | 'readDocument'>;
  owner: DocumentStore;
  target: WorkspaceTarget;
  onOpenDocument: (document: OpenDocumentRequest, range?: TextRange) => boolean;
  modeControl?: ReactNode;
}) {
  const t = useTranslations('ContentSearch');
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [result, setResult] = useState<ContentSearchResult | null>(null);
  const [phase, setPhase] = useState<'idle' | 'searching' | 'cancelled'>('idle');
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const scope = `${targetKey(target)}:${JSON.stringify([query, caseSensitive])}`;
  const current = useRef(scope);
  current.current = scope;
  const scroll = useRef<HTMLElement>(null);
  const rows = useVirtualizer({
    count: result?.matches.length ?? 0,
    getScrollElement: () => scroll.current,
    estimateSize: () => 52,
    overscan: 6,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new host or search must cancel previous reads.
  useEffect(() => {
    ++epoch.current;
    request.current?.abort();
    setResult(null);
    setPhase('idle');
    setError(null);
    return () => {
      ++epoch.current;
      request.current?.abort();
    };
  }, [scope, api]);
  const cancel = () => {
    ++epoch.current;
    request.current?.abort();
    setResult(null);
    setPhase('cancelled');
    setError(null);
  };
  const search = async () => {
    if (!query || query.length > 200) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const revision = ++epoch.current;
    const queryId = `search_${crypto.randomUUID().replaceAll('-', '')}`;
    setResult(null);
    setPhase('searching');
    setError(null);
    try {
      const found = await api.searchContents(
        target.sessionId,
        { target, queryId, query, caseSensitive },
        controller.signal,
      );
      if (controller.signal.aborted || revision !== epoch.current || current.current !== scope)
        return;
      if (
        found.queryId !== queryId ||
        targetKey(found.target) !== targetKey(target) ||
        found.query !== query ||
        found.caseSensitive !== caseSensitive
      ) {
        setError(t('stale'));
        return;
      }
      setResult(found);
    } catch (failure) {
      if (!controller.signal.aborted && revision === epoch.current && current.current === scope)
        setError(failure instanceof Error ? failure.message : t('unavailable'));
    } finally {
      if (revision === epoch.current && current.current === scope) setPhase('idle');
    }
  };
  const open = async (match: ContentSearchMatch) => {
    const revision = epoch.current;
    const currentResult = () => revision === epoch.current && current.current === scope;
    setError(null);
    try {
      const file = await api.readDocument(target.sessionId, match.path);
      if (!currentResult()) return;
      if (
        targetKey(file.target) !== targetKey(target) ||
        file.path !== match.path ||
        file.version?.sha256 !== match.sha256
      ) {
        setError(t('stale'));
        return;
      }
      const key = await owner.open(target.sessionId, match.path);
      if (!currentResult()) return;
      let entry = owner.getState().documents[key];
      if (
        entry &&
        targetKey(entry.target) === targetKey(target) &&
        !entry.dirty &&
        !entry.pendingSave &&
        entry.baseHash !== match.sha256
      ) {
        await owner.refresh(key);
        if (!currentResult()) return;
        entry = owner.getState().documents[key];
      }
      if (
        !entry ||
        targetKey(entry.target) !== targetKey(target) ||
        entry.baseHash !== match.sha256
      ) {
        setError(t('stale'));
        return;
      }
      if (entry.dirty || entry.pendingSave) {
        setError(t('draft'));
        return;
      }
      if (
        !onOpenDocument({ documentKey: key, target: entry.target, path: entry.path }, match.range)
      )
        setError(t('openFailed'));
    } catch (failure) {
      if (currentResult()) setError(failure instanceof Error ? failure.message : t('openFailed'));
    }
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-2">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
        className="flex min-w-0 flex-col gap-2"
      >
        <div className="flex min-w-0 items-center gap-2">
          {modeControl}
          <Input
            type="text"
            size="sm"
            aria-label={t('placeholder')}
            placeholder={t('placeholder')}
            maxLength={200}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={(event) => setCaseSensitive(event.target.checked)}
            />
            {t('caseSensitive')}
          </label>
          <Button
            type="submit"
            size="xs"
            variant="outline"
            disabled={!query || phase === 'searching'}
          >
            {t('search')}
          </Button>
          {phase === 'searching' ? (
            <Button size="xs" type="button" variant="ghost" onClick={cancel}>
              {t('cancel')}
            </Button>
          ) : null}
        </div>
      </form>
      <p className="text-xs text-muted">{t('diskOnly')}</p>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      <p role="status" className="text-xs text-muted">
        {phase === 'searching'
          ? t('searching')
          : phase === 'cancelled'
            ? t('cancelled')
            : result
              ? t('summary', {
                  matches: result.matches.length,
                  scanned: result.scannedFiles,
                  skipped: result.skippedFiles,
                })
              : null}
      </p>
      {result?.truncated ? (
        <p role="note" className="text-xs text-warning">
          {t('truncated')}
        </p>
      ) : null}
      {result ? (
        <section ref={scroll} className="h-64 overflow-auto" aria-label={t('contents')}>
          <div style={{ height: rows.getTotalSize(), position: 'relative' }}>
            {rows.getVirtualItems().map((row) => {
              const match = result.matches[row.index];
              if (!match) return null;
              return (
                <button
                  key={`${match.path}:${match.range.startLine}:${match.range.startColumn}`}
                  type="button"
                  aria-label={t('open', { path: match.path, line: match.range.startLine })}
                  onClick={() => void open(match)}
                  style={{
                    position: 'absolute',
                    top: row.start,
                    left: 0,
                    width: '100%',
                    height: row.size,
                  }}
                  className="flex min-w-0 flex-col justify-center gap-1 rounded px-2 text-left text-xs hover:bg-raised"
                >
                  <span className="w-full truncate">
                    {match.path}:{match.range.startLine}:{match.range.startColumn}
                  </span>
                  <span className="w-full truncate whitespace-pre font-mono text-muted">
                    {match.preview}
                  </span>
                </button>
              );
            })}
          </div>
          {!result.matches.length ? <p className="p-2 text-xs text-muted">{t('empty')}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
