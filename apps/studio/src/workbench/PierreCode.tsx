import type { ReviewCommentView } from '@corral/client';
import { Button, Select } from '@corral/react/ui';
import type { CodeViewItem, FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';
import { CodeView, WorkerPoolContextProvider } from '@pierre/diffs/react';
import HighlightWorker from '@pierre/diffs/worker/worker.js?worker';
import { type ReactNode, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { usePreferences } from './preferences.ts';
import { reviewSelection } from './reviewSelection.ts';

// Public Pierre API only.
const poolOptions = { workerFactory: () => new HighlightWorker(), poolSize: 2 };
const highlighterOptions = {
  preferredHighlighter: 'shiki-js' as const,
  theme: { dark: 'github-dark', light: 'github-light' },
};
const codeOptions = {
  theme: highlighterOptions.theme,
  preferredHighlighter: 'shiki-js' as const,
  disableFileHeader: true,
  overflow: 'scroll' as const,
  // GitHub's diff gutter red/green fails 4.5:1; text color keeps every line number readable.
  unsafeCSS: '[data-line-number-content] { color: var(--diffs-fg); }',
};

const viewerClass = 'h-[min(65vh,600px)] min-h-48 overflow-auto rounded fill-group';

function CodeFrame({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
      {children}
    </WorkerPoolContextProvider>
  );
}

export function SourceCode({
  path,
  text,
  onSelect,
}: {
  path: string;
  text: string;
  onSelect: (range: { start: number; end: number }) => void;
}) {
  const { theme } = usePreferences();
  const file = useMemo(() => ({ name: path, contents: text }), [path, text]);
  const [seen, setSeen] = useState({ file, version: 0 });
  if (seen.file !== file) setSeen({ file, version: seen.version + 1 });
  const items = useMemo<CodeViewItem<undefined>[]>(
    () => [{ id: path, type: 'file', file, version: seen.version }],
    [path, file, seen.version],
  );
  return (
    <CodeFrame>
      <CodeView
        className={viewerClass}
        style={{ fontSize: 12, lineHeight: '20px' }}
        items={items}
        options={{ ...codeOptions, themeType: theme, enableLineSelection: true }}
        onSelectedLinesChange={(selection) => {
          if (selection)
            onSelect({
              start: Math.min(selection.range.start, selection.range.end),
              end: Math.max(selection.range.start, selection.range.end),
            });
        }}
      />
    </CodeFrame>
  );
}

export type NewComment = Pick<
  ReviewCommentView,
  'side' | 'startLine' | 'endLine' | 'quote' | 'body'
>;

export function DiffCode({
  diff,
  before,
  after,
  layout,
  comments,
  onComment,
}: {
  diff: FileDiffMetadata;
  before: string;
  after: string;
  layout: 'unified' | 'split';
  comments: ReviewCommentView[];
  onComment?: (comment: NewComment) => Promise<void>;
}) {
  const t = useTranslations('Review');
  const tf = useTranslations('Files');
  const td = useTranslations('Desktop');
  const { theme } = usePreferences();
  const [range, setRange] = useState<SelectedLineRange>({
    start: 1,
    end: 1,
    side: after ? 'additions' : 'deletions',
  });
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anchor = reviewSelection(range, before, after);
  const annotations = useMemo(
    () =>
      comments.map((comment) => ({
        lineNumber: comment.startLine,
        side: comment.side === 'before' ? ('deletions' as const) : ('additions' as const),
        metadata: comment,
      })),
    [comments],
  );
  // CodeView invalidates annotation rows by version, including changes with the same count.
  const [seen, setSeen] = useState({ comments, version: 0 });
  if (seen.comments !== comments) setSeen({ comments, version: seen.version + 1 });
  const items = useMemo<CodeViewItem<ReviewCommentView>[]>(
    () => [{ id: 'comparison', type: 'diff', fileDiff: diff, annotations, version: seen.version }],
    [diff, annotations, seen.version],
  );
  const choose = (selection: SelectedLineRange) => {
    setRange(selection);
    if (reviewSelection(selection, before, after)) {
      setOpen(true);
      setError(null);
    }
  };
  return (
    <div className="space-y-2" data-testid="pierre-diff">
      {onComment ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Select
            label={td('commentSide')}
            size="xs"
            value={range.side ?? 'additions'}
            onValueChange={(side) => setRange((r) => ({ ...r, side, endSide: undefined }))}
            options={[
              { value: 'deletions' as const, label: tf('before') },
              { value: 'additions' as const, label: tf('after') },
            ]}
          />
          <label>
            {td('fromLine')}{' '}
            <input
              type="number"
              min={1}
              value={range.start}
              onChange={(e) => setRange((r) => ({ ...r, start: e.target.valueAsNumber || 1 }))}
              className="w-14 rounded fill-control px-1"
            />
          </label>
          <label>
            {td('toLine')}{' '}
            <input
              type="number"
              min={1}
              value={range.end}
              onChange={(e) => setRange((r) => ({ ...r, end: e.target.valueAsNumber || 1 }))}
              className="w-14 rounded fill-control px-1"
            />
          </label>
          <Button size="xs" variant="outline" disabled={!anchor} onClick={() => setOpen(true)}>
            {t('commentLine', { line: Math.min(range.start, range.end) })}
          </Button>
        </div>
      ) : null}
      {open && anchor && onComment ? (
        <form
          className="space-y-2 rounded-lg fill-group p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy || !body.trim()) return;
            setBusy(true);
            setError(null);
            void onComment({ ...anchor, body })
              .then(
                () => {
                  setOpen(false);
                  setBody('');
                },
                (failure: unknown) =>
                  setError(failure instanceof Error ? failure.message : String(failure)),
              )
              .finally(() => setBusy(false));
          }}
        >
          <p className="text-xs text-muted">
            {anchor.side === 'before' ? tf('before') : tf('after')} · {anchor.startLine}–
            {anchor.endLine}
          </p>
          <textarea
            ref={(node) => node?.focus()}
            aria-label={t('commentLine', { line: anchor.startLine })}
            placeholder={t('commentPlaceholder')}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={2}
            className="w-full rounded fill-group p-2 text-xs"
          />
          <div className="flex gap-2">
            <Button type="submit" size="xs" disabled={busy || !body.trim()}>
              {t('addComment')}
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
          </div>
          {error ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
      <CodeFrame>
        <CodeView
          className={viewerClass}
          style={{ fontSize: 12, lineHeight: '20px' }}
          items={items}
          renderGutterUtility={
            onComment
              ? (hoveredLine) => (
                  <button
                    type="button"
                    aria-label={t('addComment')}
                    onClick={() => {
                      const line = hoveredLine();
                      if (line)
                        choose({
                          start: line.lineNumber,
                          end: line.lineNumber,
                          side:
                            'side' in line &&
                            (line.side === 'deletions' || line.side === 'additions')
                              ? line.side
                              : 'additions',
                        });
                    }}
                  >
                    +
                  </button>
                )
              : undefined
          }
          selectedLines={{ id: 'comparison', range }}
          onSelectedLinesChange={(selection) => {
            if (selection) setRange(selection.range);
          }}
          options={{
            ...codeOptions,
            themeType: theme,
            diffStyle: layout,
            enableLineSelection: true,
            enableGutterUtility: !!onComment,
            hunkSeparators: 'line-info',
          }}
          renderAnnotation={({ metadata }) => (
            <p
              data-testid="inline-comment"
              className="border-l-2 border-accent bg-raised px-3 py-2 font-sans text-xs"
            >
              {metadata.body}{' '}
              <span className="text-muted">· {t(`commentState.${metadata.state}`)}</span>
            </p>
          )}
        />
      </CodeFrame>
    </div>
  );
}
