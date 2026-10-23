import type { SessionSearchResult } from '@corral/contracts';
import {
  Button,
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  Input,
} from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';

export function SessionSearchDialog({
  open,
  onOpenChange,
  initialQuery,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  initialQuery: string;
}) {
  const t = useTranslations('SessionSearch');
  const { workspaces } = useServices();
  const [query, setQuery] = useState(initialQuery),
    [privateText, setPrivateText] = useState(false),
    [archived, setArchived] = useState(false);
  const [result, setResult] = useState<SessionSearchResult | null>(null),
    [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setOffset(0);
    }
  }, [open, initialQuery]);
  useEffect(() => {
    if (!open || !workspaces || !query.trim()) {
      setResult(null);
      return;
    }
    let current = true;
    setResult(null);
    setError(null);
    const timer = setTimeout(() => {
      void revision;
      void workspaces
        .searchSessions({
          query,
          includeTranscript: privateText,
          includeArchived: archived,
          offset,
        })
        .then((value) => {
          if (current) setResult(value);
        })
        .catch(() => {
          if (current) setError(t('failed'));
        });
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, query, privateText, archived, offset, revision, workspaces, t]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('privacy')}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <Input
            aria-label={t('query')}
            value={query}
            maxLength={200}
            onChange={(event) => {
              setQuery(event.target.value);
              setOffset(0);
            }}
          />
          <div className="flex flex-wrap gap-3 text-sm">
            <label>
              <input
                type="checkbox"
                checked={privateText}
                onChange={(event) => {
                  setPrivateText(event.target.checked);
                  setOffset(0);
                }}
              />{' '}
              {t('private')}
            </label>
            <label>
              <input
                type="checkbox"
                checked={archived}
                onChange={(event) => {
                  setArchived(event.target.checked);
                  setOffset(0);
                }}
              />{' '}
              {t('archived')}
            </label>
          </div>
          {result ? (
            <p role="status" className="text-xs text-muted-foreground">
              {t(result.scope)} · {t('count', { count: result.total })}
            </p>
          ) : null}
          <ul className="max-h-[50vh] space-y-2 overflow-y-auto">
            {result?.hits.map((hit) => (
              <li key={`${hit.sessionId}:${hit.runId}:${hit.sequence}:${hit.entryId}:${hit.kind}`}>
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId: hit.sessionId }}
                  search={
                    hit.entryId
                      ? { message: hit.entryId }
                      : hit.runId
                        ? {
                            panel: 'run',
                            run: hit.runId,
                            view: hit.artifactVersionId ? 'results' : 'run',
                            artifact: hit.artifactVersionId ?? undefined,
                          }
                        : {}
                  }
                  onClick={() => onOpenChange(false)}
                  className="block rounded fill-group p-2 hover:bg-subtle"
                >
                  <span className="text-sm font-medium">{hit.title}</span>{' '}
                  <span className="text-xs text-muted-foreground">
                    {t(`kind.${hit.kind}`)}
                    {hit.archived ? ` · ${t('archived')}` : ''}
                  </span>
                  <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                    {hit.excerpt}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button
              size="compact"
              variant="tertiary"
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              {t('previous')}
            </Button>
            <Button
              size="compact"
              variant="tertiary"
              disabled={!result || offset + 50 >= result.total}
              onClick={() => setOffset(offset + 50)}
            >
              {t('next')}
            </Button>
            <Button
              size="compact"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void workspaces
                  ?.rebuildSessionSearch()
                  .then(() => setRevision((value) => value + 1))
                  .catch(() => setError(t('failed')))
                  .finally(() => setBusy(false));
              }}
            >
              {t('rebuild')}
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-danger">
              {error}
            </p>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
