import type { ReviewCommentView } from '@corral/client';
import { cn } from '@corral/react/design-kit';
import type { CodeViewItem, FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';
import { CodeView, type CodeViewHandle, WorkerPoolContextProvider } from '@pierre/diffs/react';
import HighlightWorker from '@pierre/diffs/worker/worker.js?worker';
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { type DiffLabels, localizeDiffLabels } from './diffLabels.ts';
import { usePreferences } from './preferences.ts';
import { CommentBody } from './ReviewCommentForm.tsx';
import { prefersReducedMotion } from './reviewNavigation.ts';

// Public Pierre API only.
const poolOptions = { workerFactory: () => new HighlightWorker(), poolSize: 2 };
const highlighterOptions = {
  preferredHighlighter: 'shiki-js' as const,
  theme: { dark: 'github-dark', light: 'github-light' },
};
// The code sits on the app's own surface in both themes, not on the highlighting theme's
// (GitHub's slate in dark): its background is the app background, its separators the quiet
// fill, and the added/removed tints are mixed from that background. The text uses the kit code
// type (the caption role), on the kit diff's 20px rows. App tokens reach the renderer's shadow
// root by inheritance.
const surfaceCSS = `:host {
  --diffs-light-bg: var(--background);
  --diffs-dark-bg: var(--background);
  --diffs-bg-separator-override: var(--muted);
  --diffs-font-size: var(--fs-caption);
  --diffs-line-height: var(--lh-body);
}`;
const codeOptions = {
  theme: highlighterOptions.theme,
  preferredHighlighter: 'shiki-js' as const,
  disableFileHeader: true,
  overflow: 'scroll' as const,
  // GitHub's diff gutter red/green fails 4.5:1; text color keeps every line number readable.
  unsafeCSS: `${surfaceCSS}\n[data-line-number-content] { color: var(--diffs-fg); }`,
};
// The renderer hangs its line "+" past the number column into the code, over the line's first
// character; it stays inside the gutter, over the hovered line's number.
const gutterCSS = '[data-utility-button] { margin-right: 0; }';

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

/** Scrolls the shown diff to one of its changes. */
export interface DiffHandle {
  revealHunk(index: number): void;
}

/**
 * One file's diff. Lines are picked in the diff itself: a click on a line number, a drag or
 * Shift+click across numbers, or the "+" that follows the pointer in the gutter. `onSelection`
 * follows the range while it is drawn and `onPick` reports the finished one; the owner shows
 * `selection` back as the highlighted range. Long lines wrap, so the diff never runs wider
 * than its column.
 */
export function DiffCode({
  diff,
  layout,
  comments,
  selection = null,
  onSelection,
  onPick,
  handle,
  className,
}: {
  diff: FileDiffMetadata;
  layout: 'unified' | 'split';
  comments: ReviewCommentView[];
  /** The highlighted line range, if any. */
  selection?: SelectedLineRange | null;
  onSelection?(range: SelectedLineRange): void;
  /** Absent where comments do not apply; lines are then not picked. */
  onPick?(range: SelectedLineRange): void;
  /** Filled with this diff's scroll moves while it is shown. */
  handle?: RefObject<DiffHandle | null> | undefined;
  /** The scroll box's size; the default suits a diff inside a longer page. */
  className?: string;
}) {
  const t = useTranslations('Review');
  const { theme } = usePreferences();
  const td = useTranslations('Review.diff');
  const labels = useRef<DiffLabels | null>(null);
  labels.current = {
    unmodifiedLines: (count) => td('unmodifiedLines', { count }),
    moreContext: td('moreContext'),
    expandAll: td('expandAll'),
    noNewline: td('noNewline'),
    expandUp: td('expandUp'),
    expandDown: td('expandDown'),
    expandBoth: td('expandBoth'),
  };
  const viewer = useRef<CodeViewHandle<ReviewCommentView, undefined>>(null);
  const annotations = useMemo(
    () =>
      comments.map((comment) => ({
        lineNumber: comment.endLine,
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
  useEffect(() => {
    if (!handle) return;
    const value: DiffHandle = {
      revealHunk(index) {
        const hunk = diff.hunks[index];
        if (!hunk) return;
        const added = hunk.additionCount > 0;
        viewer.current?.scrollTo({
          type: 'line',
          id: 'comparison',
          lineNumber: added ? hunk.additionStart : hunk.deletionStart,
          side: added ? 'additions' : 'deletions',
          align: 'start',
          behavior: prefersReducedMotion() ? 'instant' : 'smooth',
        });
      },
    };
    handle.current = value;
    return () => {
      if (handle.current === value) handle.current = null;
    };
  }, [handle, diff]);
  return (
    <CodeFrame>
      <CodeView
        ref={viewer}
        className={cn('min-h-24 overflow-auto', className ?? 'max-h-[min(65vh,600px)] rounded')}
        items={items}
        selectedLines={selection ? { id: 'comparison', range: selection } : null}
        onSelectedLinesChange={(next) => {
          if (next) onSelection?.(next.range);
        }}
        options={{
          ...codeOptions,
          unsafeCSS: `${codeOptions.unsafeCSS}\n${gutterCSS}`,
          overflow: 'wrap',
          themeType: theme,
          diffStyle: layout,
          enableLineSelection: true,
          enableGutterUtility: Boolean(onPick),
          hunkSeparators: 'line-info',
          // The renderer's own words come from the catalog (diffLabels.ts).
          onPostRender: (node: HTMLElement, _diff: unknown, phase: string) => {
            if (phase !== 'unmount' && labels.current)
              localizeDiffLabels(node.shadowRoot ?? node, labels.current);
          },
          ...(onPick
            ? {
                onLineSelectionEnd: (range: SelectedLineRange | null) => {
                  if (range) onPick(range);
                },
                onGutterUtilityClick: (range: SelectedLineRange) => onPick(range),
              }
            : {}),
        }}
        renderAnnotation={({ metadata }) => (
          <p
            data-testid="inline-comment"
            className="m-0 border-l-2 border-primary bg-card px-3 py-2 font-sans text-caption"
          >
            <CommentBody body={metadata.body} />{' '}
            <span className="text-muted-foreground">· {t(`commentState.${metadata.state}`)}</span>
          </p>
        )}
      />
    </CodeFrame>
  );
}
