import type { SessionSearchHit, SessionSearchResult, SessionSearchSource } from '@corral/contracts';
import {
  Button,
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  Input,
  Switch,
} from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';

const searchHitKey = (hit: SessionSearchHit) =>
  JSON.stringify([
    hit.sessionId,
    hit.kind,
    hit.runId,
    hit.entryId,
    hit.artifactVersionId,
    hit.sequence,
  ]);

export function groupSearchHits(hits: SessionSearchHit[]) {
  const groups = new Map<string, { sessionId: string; title: string; hits: SessionSearchHit[] }>();
  const seen = new Set<string>();
  for (const hit of hits) {
    const key = searchHitKey(hit);
    if (seen.has(key)) continue;
    seen.add(key);
    const group = groups.get(hit.sessionId) ?? {
      sessionId: hit.sessionId,
      title: hit.title,
      hits: [],
    };
    group.hits.push(hit);
    groups.set(hit.sessionId, group);
  }
  return [...groups.values()];
}

export function SearchExcerpt({
  text,
  query,
  matches,
}: {
  text: string;
  query: string;
  matches?: SessionSearchHit['excerptMatches'];
}) {
  if (matches) {
    const content: ReactNode[] = [];
    let offset = 0;
    for (const { start, end } of matches) {
      content.push(
        text.slice(offset, start),
        <mark key={`${start}:${end}`}>{text.slice(start, end)}</mark>,
      );
      offset = end;
    }
    content.push(text.slice(offset));
    return content;
  }
  const needle = query.trim().normalize('NFKC');
  if (!needle) return text;
  const literal = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.split(new RegExp(`(${literal})`, 'gi')).map((part, index) =>
    // biome-ignore lint/suspicious/noArrayIndexKey: static text matches have no state or identity beyond their position
    index % 2 ? <mark key={index}>{part}</mark> : part,
  );
}

function SearchResult({
  hit,
  query,
  onNavigate,
}: {
  hit: SessionSearchHit;
  query: string;
  onNavigate(): void;
}) {
  const t = useTranslations('SessionSearch');
  const tw = useTranslations('Workbench');
  const sources = hit.sources ?? [hit];
  const link = (source: SessionSearchSource, content: ReactNode) => (
    <Link
      to="/sessions/$sessionId"
      params={{ sessionId: hit.sessionId }}
      search={
        source.entryId
          ? { message: source.entryId }
          : source.runId
            ? {
                panel: 'run',
                run: source.runId,
                view: source.artifactVersionId ? 'results' : 'run',
                result: source.artifactVersionId ?? undefined,
                atSeq: source.artifactVersionId ? undefined : (source.sequence ?? undefined),
              }
            : {}
      }
      onClick={onNavigate}
      className="block rounded fill-group p-2 hover:bg-subtle"
    >
      {content}
    </Link>
  );
  const content = (
    <>
      <span className="block text-xs text-muted-foreground">
        {hit.runNumber ? `${tw('runNumber', { number: hit.runNumber })} · ` : ''}
        {[...new Set(sources.map((source) => t(`kind.${source.kind}`)))].join(' · ')}
        {hit.archived ? ` · ${t('archived')}` : ''}
        {sources.length > 1 ? ` · ${t('sourceCount', { count: sources.length })}` : ''}
      </span>
      <span className="block whitespace-pre-wrap break-words text-xs">
        <SearchExcerpt text={hit.excerpt} query={query} matches={hit.excerptMatches} />
      </span>
    </>
  );
  return sources.length > 1 ? (
    <details>
      <summary className="rounded p-2">{content}</summary>
      <ul className="space-y-1 pl-3">
        {sources.map((source, index) => (
          <li key={JSON.stringify(source)}>
            {link(
              source,
              `${t(`kind.${source.kind}`)} · ${t('sourceNumber', { number: index + 1 })}`,
            )}
          </li>
        ))}
      </ul>
    </details>
  ) : (
    link(hit, content)
  );
}

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
          <p className="text-caption text-muted-foreground">{t('dialogScope')}</p>
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
            <Switch
              label={t('private')}
              checked={privateText}
              onToggle={() => {
                setPrivateText(!privateText);
                setOffset(0);
              }}
            />
            <Switch
              label={t('archived')}
              checked={archived}
              onToggle={() => {
                setArchived(!archived);
                setOffset(0);
              }}
            />
          </div>
          {result ? (
            <p role="status" className="text-xs text-muted-foreground">
              {t(result.scope)} · {t('count', { count: result.total })}
            </p>
          ) : null}
          {result?.total === 0 && !privateText ? (
            <p role="status" className="text-caption">
              {t('privateEmpty')}
            </p>
          ) : null}
          <ul className="max-h-[50vh] space-y-3 overflow-y-auto">
            {groupSearchHits(result?.hits ?? []).map((group) => (
              <li key={group.sessionId}>
                <h3 className="text-sm font-medium">
                  <SearchExcerpt text={group.title} query={query} />
                </h3>
                <ul className="space-y-1">
                  {group.hits.map((hit) => (
                    <li key={searchHitKey(hit)}>
                      <SearchResult
                        hit={hit}
                        query={query}
                        onNavigate={() => onOpenChange(false)}
                      />
                    </li>
                  ))}
                </ul>
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
