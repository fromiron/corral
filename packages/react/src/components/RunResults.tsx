import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { diffLines } from '../artifacts/diff.ts';
import { Button, RadioGroup, RadioItem } from '../design-kit/index.ts';
import { type ResultItem, runResults } from '../run/results.ts';
import type { RunSessionStore } from '../run/session.ts';
import { GeneratedImage } from './ArtifactViewer.tsx';
import { SafeMarkdown } from './SafeMarkdown.tsx';

/** A whole HTML document, as models sometimes write; only these get a preview (CR-009). */
export function isHtmlDocument(text: string): boolean {
  return /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(text);
}

/** No scripts, forms or network; inline styles and data: images only (CR-009, WBTST-034). */
export const PREVIEW_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

/** The document with the preview policy in front, for runtimes with no preview address. */
export function sandboxedSrcDoc(html: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_POLICY}">${html}`;
}

type Format = 'document' | 'source' | 'preview';

/**
 * Everything a run produced, read in a wide pane (CR-009): the Output's final results, the
 * work in between grouped by artifact, and a failed run's work as a partial result. Run,
 * review and submission are shown apart. File/check evidence belongs to the session panels.
 */
export function RunResults({
  session,
  selectedId,
  onSelect,
  previewUrl,
  onStartFrom,
}: {
  session: RunSessionStore;
  /** The chosen version (from the address); null opens the first final result. */
  selectedId: string | null;
  onSelect: (artifactVersionId: string) => void;
  /** A separate, sandboxed address for an HTML preview; without it a srcdoc frame is used. */
  previewUrl?: (runId: string, artifactVersionId: string) => string | null;
  onStartFrom?: (from: { runId: string; artifactVersionId: string; label: string }) => void;
}) {
  const t = useTranslations('Results');
  const projection = useStore(session, (s) => s.projection);
  const results = useMemo(() => (projection ? runResults(projection) : null), [projection]);
  if (!projection || !results) return null;

  const all = [...results.final, ...results.intermediate.flatMap((g) => g.versions)];
  const chosen =
    all.find((r) => r.artifactVersionId === selectedId) ??
    all.find((r) => r.artifactVersionId === results.defaultId) ??
    null;

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
          {results.kind === 'final' ? null : (
            <p role="status" className="rounded fill-group p-2 text-xs text-muted-foreground">
              {t(`kind.${results.kind}`, { status: projection.status })}
            </p>
          )}
          {results.final.length > 0 ? (
            <ResultSection heading={t('final')}>
              {results.final.map((item) => (
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
          {results.intermediate.length > 0 ? (
            <ResultSection heading={results.kind === 'partial' ? t('partial') : t('intermediate')}>
              {results.intermediate.map((group) => (
                <li key={group.artifactId} className="flex flex-col gap-1">
                  <ResultButton
                    session={session}
                    item={group.latest}
                    chosen={chosen?.artifactVersionId === group.latest.artifactVersionId}
                    onSelect={onSelect}
                    bare
                  />
                  {group.versions.length > 1 ? (
                    <details
                      className="pl-3 text-xs"
                      open={group.versions.some(
                        (v, i) => i > 0 && v.artifactVersionId === chosen?.artifactVersionId,
                      )}
                    >
                      <summary className="cursor-pointer text-muted-foreground">
                        {t('earlier', { count: group.versions.length - 1 })}
                      </summary>
                      <ul className="mt-1 flex flex-col gap-1">
                        {group.versions.slice(1).map((item) => (
                          <ResultButton
                            key={item.artifactVersionId}
                            session={session}
                            item={item}
                            chosen={chosen?.artifactVersionId === item.artifactVersionId}
                            onSelect={onSelect}
                          />
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </li>
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
            {...(onStartFrom ? { onStartFrom } : {})}
          />
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

function useAuthorLabel(session: RunSessionStore, executionId: string): string {
  return useStore(session, (s) => {
    const nodeId = s.projection?.executions[executionId]?.nodeId;
    if (!nodeId) return '';
    return s.definition?.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
  });
}

function ResultButton({
  session,
  item,
  chosen,
  onSelect,
  bare = false,
}: {
  session: RunSessionStore;
  item: ResultItem;
  chosen: boolean;
  onSelect: (id: string) => void;
  /** Already inside a list item. */
  bare?: boolean;
}) {
  const t = useTranslations('Results');
  const ta = useTranslations('Artifact');
  const author = useAuthorLabel(session, item.authorExecutionId);
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
  return bare ? button : <li>{button}</li>;
}

export function ResultReader({
  session,
  item,
  previewUrl,
  onStartFrom,
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
  const status = useStore(session, (s) => s.projection?.status ?? 'created');
  const text = useStore(session, (s) => s.artifactTexts[id]);
  const parentText = useStore(session, (s) =>
    item.parentVersionId ? s.artifactTexts[item.parentVersionId] : undefined,
  );
  const author = useAuthorLabel(session, item.authorExecutionId);
  const [failed, setFailed] = useState(false);
  const [chosenFormat, setFormat] = useState<Format | null>(null);
  const [comparing, setComparing] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (item.media) return;
    void session
      .getState()
      .loadArtifact(id)
      .catch(() => setFailed(true));
  }, [session, id, item.media]);
  useEffect(() => {
    if (comparing && item.parentVersionId)
      void session.getState().loadArtifact(item.parentVersionId);
  }, [session, comparing, item.parentVersionId]);

  const html = text !== undefined && isHtmlDocument(text);
  const formats: Format[] = html ? ['preview', 'source'] : ['document', 'source'];
  const format = chosenFormat && formats.includes(chosenFormat) ? chosenFormat : formats[0];
  const label = t('itemName', { name: item.name, version: item.version });
  const diff = useMemo(
    () =>
      comparing && text !== undefined && parentText !== undefined
        ? diffLines(parentText, text)
        : null,
    [comparing, text, parentText],
  );

  const copy = async () => {
    if (text === undefined) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const download = () => {
    if (text === undefined) return;
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
  const src = html && runId && previewUrl ? previewUrl(runId, id) : null;

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
              {item.parentVersionId ? (
                <Button
                  type="button"
                  aria-pressed={comparing}
                  onClick={() => setComparing(!comparing)}
                  variant="tertiary"
                  size="compact"
                >
                  {comparing ? ta('hideCompare') : t('comparePrevious')}
                </Button>
              ) : null}
            </>
          ) : null}
          {onStartFrom && runId ? (
            <Button
              type="button"
              onClick={() => onStartFrom({ runId, artifactVersionId: id, label })}
              variant="secondary"
              size="compact"
            >
              {ta('newRunFromVersion')}
            </Button>
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
        ) : diff ? (
          <pre className="mx-auto max-w-4xl whitespace-pre-wrap break-words font-mono text-ui">
            {diff.map((line, index) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity beyond their position
                key={index}
                className={`block ${line.kind === 'added' ? 'bg-success/15' : line.kind === 'removed' ? 'bg-danger/15 line-through' : ''}`}
              >
                {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
                {line.text}
              </span>
            ))}
          </pre>
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
