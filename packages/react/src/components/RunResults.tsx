import { canReadArtifactBody } from '@corral/core';
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { Button, RadioGroup, RadioItem } from '../design-kit/index.ts';
import { useRunDisplay } from '../run/display.tsx';
import { type ResultItem, runResults } from '../run/results.ts';
import type { RunSessionStore } from '../run/session.ts';
import { GeneratedImage } from './ArtifactViewer.tsx';
import { SafeMarkdown } from './SafeMarkdown.tsx';

/** A whole HTML document, as models sometimes write; only these get a preview. */
export function isHtmlDocument(text: string): boolean {
  return /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(text);
}

/** No scripts, forms or network; inline styles and data: images only. */
export const PREVIEW_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

/** The document with the preview policy in front, for runtimes with no preview address. */
export function sandboxedSrcDoc(html: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_POLICY}">${html}`;
}

type Format = 'document' | 'source' | 'preview';

/**
 * Current final results, read in a wide pane. Earlier artifact bodies are not a result
 * archive; their creation and delivery relationships belong to the execution flow.
 */
export function RunResults({
  session,
  runNumber,
  selectedId,
  onSelect,
  previewUrl,
}: {
  session: RunSessionStore;
  runNumber?: number;
  /** The chosen version (from the address); null opens the first final result. */
  selectedId: string | null;
  onSelect: (artifactVersionId: string) => void;
  /** A separate, sandboxed address for an HTML preview; without it a srcdoc frame is used. */
  previewUrl?: (runId: string, artifactVersionId: string) => string | null;
  onStartFrom?: (from: { runId: string; artifactVersionId: string; label: string }) => void;
}) {
  const t = useTranslations('Results');
  const tw = useTranslations('Workbench');
  const targetText = useTranslations('RunPage');
  const projection = useRunDisplay(session, (s) => s.projection);
  const currentProjection = useStore(session, (s) => s.projection);
  const results = useMemo(() => (projection ? runResults(projection) : null), [projection]);
  if (!projection || !results) return null;

  const current = results.final.filter((item) =>
    canReadArtifactBody(currentProjection, item.artifactVersionId),
  );
  const chosen =
    current.find(
      (item) => item.artifactVersionId === (selectedId ?? current[0]?.artifactVersionId),
    ) ?? null;

  return (
    // UX-03: one column until the results have room for a list beside the text, measured on
    // this view's own width (a side panel is narrow on any screen).
    <div className="@container h-full min-h-0">
      <div
        className="flex h-full min-h-0 flex-col overflow-auto @3xl:flex-row @3xl:overflow-hidden"
        data-testid="run-results"
      >
        <nav
          aria-label={t('label')}
          className="flex max-h-40 shrink-0 flex-col gap-3 overflow-auto border-b border-line p-3 @3xl:max-h-none @3xl:w-72 @3xl:border-r @3xl:border-b-0"
        >
          {runNumber ? (
            <p className="text-xs text-muted-foreground">
              {tw('runNumber', { number: runNumber })}
            </p>
          ) : null}
          {current.length === 0 && selectedId === null ? (
            <p role="status" className="text-caption text-muted-foreground">
              {t('noCurrentResult')}
            </p>
          ) : null}
          {current.length > 0 ? (
            <ResultSection heading={t('final')}>
              {current.map((item) => (
                <ResultButton
                  key={item.artifactVersionId}
                  session={session}
                  item={item}
                  chosen={chosen?.artifactVersionId === item.artifactVersionId}
                  onSelect={onSelect}
                />
              ))}
            </ResultSection>
          ) : null}
        </nav>
        {chosen ? (
          <ResultReader
            key={chosen.artifactVersionId}
            session={session}
            item={chosen}
            {...(previewUrl ? { previewUrl } : {})}
          />
        ) : selectedId !== null ? (
          <p role="alert" className="p-3 text-sm text-warning">
            {projection.artifacts[selectedId]
              ? t('unavailable')
              : targetText('resultMissing', { result: selectedId })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ResultSection({ heading, children }: { heading: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1">
      <h3 id={id} className="text-xs font-semibold text-muted-foreground">
        {heading}
      </h3>
      <ul className="flex flex-col gap-1">{children}</ul>
    </section>
  );
}

function useAuthorLabel(session: RunSessionStore, item: ResultItem): string {
  const t = useTranslations('Results');
  const nodeId = useRunDisplay(
    session,
    (s) => s.projection?.executions[item.authorExecutionId]?.nodeId,
  );
  const name = useStore(session, (s) =>
    nodeId ? (s.definition?.nodes.find((n) => n.id === nodeId)?.label ?? nodeId) : '',
  );
  return [
    name,
    item.authorExecutionNumber
      ? t('authorExecution', { number: item.authorExecutionNumber })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function ResultButton({
  session,
  item,
  chosen,
  onSelect,
}: {
  session: RunSessionStore;
  item: ResultItem;
  chosen: boolean;
  onSelect: (id: string) => void;
}) {
  const t = useTranslations('Results');
  const ta = useTranslations('Artifact');
  const author = useAuthorLabel(session, item);
  const button = (
    <Button
      type="button"
      aria-current={chosen ? 'true' : undefined}
      onClick={() => onSelect(item.artifactVersionId)}
      variant={chosen ? 'secondary' : 'ghost'}
      size="compact"
      className="h-auto w-full justify-start py-2 text-left whitespace-normal"
    >
      <span className="flex min-w-0 flex-col items-start">
        <span className="font-medium">
          {t('itemName', { name: item.name, version: item.version })}
        </span>
        <span className="text-xs text-muted-foreground">
          {[author, item.review ? ta(`verdict.${item.review.verdict}`) : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
    </Button>
  );
  return <li>{button}</li>;
}

export function ResultReader({
  session,
  item,
  previewUrl,
  embedded = false,
}: {
  session: RunSessionStore;
  item: ResultItem;
  previewUrl?: (runId: string, artifactVersionId: string) => string | null;
  onStartFrom?: (from: { runId: string; artifactVersionId: string; label: string }) => void;
  /** The surrounding panel already shows run status. Review and submission stay. */
  embedded?: boolean;
}) {
  const t = useTranslations('Results');
  const ta = useTranslations('Artifact');
  const ts = useTranslations('Status');
  const headingId = useId();
  const id = item.artifactVersionId;
  const runId = useStore(session, (s) => s.runId);
  const projection = useRunDisplay(session, (s) => s.projection);
  const currentProjection = useStore(session, (s) => s.projection);
  const status = projection?.status ?? 'created';
  const canLoad = Boolean(projection?.artifacts[id]) && canReadArtifactBody(currentProjection, id);
  const text = useStore(session, (s) => s.artifactTexts[id]);
  const author = useAuthorLabel(session, item);
  const [failed, setFailed] = useState(false);
  const [chosenFormat, setFormat] = useState<Format | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!canLoad || item.media) return;
    void session
      .getState()
      .loadArtifact(id)
      .catch(() => setFailed(true));
  }, [session, id, item.media, canLoad]);

  const html = text !== undefined && isHtmlDocument(text);
  const formats: Format[] = html ? ['preview', 'source'] : ['document', 'source'];
  const format = chosenFormat && formats.includes(chosenFormat) ? chosenFormat : formats[0];
  const label = t('itemName', { name: item.name, version: item.version });

  const copy = async () => {
    if (!canLoad || text === undefined) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const download = () => {
    if (!canLoad || text === undefined) return;
    const extension = html ? 'html' : item.contract === 'review' ? 'json' : 'md';
    const url = URL.createObjectURL(
      new Blob([text], { type: html ? 'text/html' : 'text/plain;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `${item.name}-v${item.version}.${extension}`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const src = canLoad && html && runId && previewUrl ? previewUrl(runId, id) : null;

  if (!canLoad)
    return (
      <p role="status" className="p-4 text-body text-muted-foreground">
        {ta('retired')}
      </p>
    );

  return (
    <article aria-labelledby={headingId} className="flex min-w-0 flex-col @3xl:min-h-0 @3xl:flex-1">
      <header className="flex flex-col gap-2 border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id={headingId} className="text-lg font-semibold">
            {label}
          </h2>
          <span className="text-xs text-muted-foreground">
            {[author, item.contract, t('bytes', { bytes: item.byteLength })]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
        <ul aria-label={t('stateLabel')} className="flex flex-wrap gap-2 text-xs">
          {embedded ? null : (
            <li className="rounded fill-control px-2 py-0.5">
              {t('runState', { status: ts(status) })}
            </li>
          )}
          <li className="rounded fill-control px-2 py-0.5">
            {item.review
              ? t('reviewState', { verdict: ta(`verdict.${item.review.verdict}`) }) +
                (item.review.stale ? ` · ${t('stale')}` : '')
              : t('noReview')}
          </li>
          <li className="rounded fill-control px-2 py-0.5">
            {item.submitted ? t('submitted') : t('notSubmitted')}
          </li>
        </ul>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {!item.media ? (
            <>
              <RadioGroup
                aria-label={t('format')}
                value={format}
                onValueChange={(value) => setFormat(value as Format)}
                size="compact"
              >
                {formats.map((value, index) => (
                  <RadioItem
                    key={value}
                    value={value}
                    index={index}
                    label={t(`formats.${value}`)}
                  />
                ))}
              </RadioGroup>
              <Button
                type="button"
                disabled={text === undefined}
                onClick={() => void copy()}
                variant="tertiary"
                size="compact"
              >
                {copied ? t('copied') : t('copy')}
              </Button>
              <Button
                type="button"
                disabled={text === undefined}
                onClick={download}
                variant="tertiary"
                size="compact"
              >
                {t('download')}
              </Button>
            </>
          ) : null}
        </div>
      </header>
      <div
        data-testid="result-body"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the body scrolls and must be reachable by keyboard
        tabIndex={0}
        className="px-4 py-4 @3xl:min-h-0 @3xl:flex-1 @3xl:overflow-auto"
      >
        {item.media && runId ? (
          <GeneratedImage runId={runId} versionId={id} name={item.name} media={item.media} />
        ) : text === undefined ? (
          <p className="text-sm text-muted-foreground">
            {failed ? t('unavailable') : ta('loading')}
          </p>
        ) : format === 'source' ? (
          <pre className="mx-auto max-w-4xl whitespace-pre-wrap break-words font-mono text-ui">
            {text}
          </pre>
        ) : format === 'preview' ? (
          <iframe
            title={t('previewOf', { label })}
            sandbox=""
            referrerPolicy="no-referrer"
            {...(src ? { src } : { srcDoc: sandboxedSrcDoc(text) })}
            className="h-full min-h-[60vh] w-full rounded border border-line bg-white"
          />
        ) : (
          <div className="mx-auto max-w-3xl">
            <SafeMarkdown text={text} size="reader" />
          </div>
        )}
      </div>
    </article>
  );
}
