'use client';

// A change an agent wants to write, held until the user answers. Header: the
// file count and +/− totals. Body: the agent's note, one tab per file with its
// path, line-numbered hunks tinted for adds and deletes (long unchanged runs
// fold behind "Show N unchanged lines"), and Reject (with feedback) / Approve.
// The parent owns `state`: `approved` shows the write bar, `written` folds to
// the file list, `rejected` folds to the feedback. The selected tab, opened
// folds and the feedback draft are internal UI state.

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  createContext,
  type FormEvent,
  forwardRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useControllable } from '../../hooks/use-controllable.ts';
import { useFluidHover, useRegisterFluidHoverItem } from '../../hooks/use-fluid-hover.ts';
import { focusRingInset } from '../../lib/focus.ts';
import { useIcons } from '../../lib/icon-context.tsx';
import { useShape } from '../../lib/shape-context.tsx';
import { type SizeVariant, useSize } from '../../lib/size-context.tsx';
import { spring, tween } from '../../lib/springs.ts';
import { assignRef, cn } from '../../lib/utils.ts';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { FluidHoverHighlight } from '../ui/fluid-hover-highlight.tsx';
import { InputField, InputGroup } from '../ui/input-group.tsx';
import { ScrollArea } from '../ui/scroll-area.tsx';
import { TabsSubtle, TabsSubtleItem } from '../ui/tabs-subtle.tsx';
import {
  AgentCard,
  AgentStatusIcon,
  Collapse,
  DisclosureChevron,
  DrawnCheck,
  Meter,
  Roll,
  SizeScope,
} from './agent-primitives.tsx';

// ─── Types ───────────────────────────────────────────────────────────────────

/** `add` and `del` are changed lines; `ctx` is unchanged context. */
type DiffLineType = 'add' | 'del' | 'ctx';

interface DiffLine {
  /** Added, removed, or unchanged context. */
  type: DiffLineType;
  /** Gutter number: the new file's line for `add` / `ctx`, the old file's for `del`. */
  n?: number;
  /** The line's text without the leading `+` / `-`; indentation is kept. */
  text: string;
}

interface DiffHunk {
  /** Stable key; falls back to the hunk's index. */
  id?: string;
  /** Shown on the separator above the hunk (`@@ -18,3 +19,3 @@`, an enclosing function). */
  header?: string;
  /** The hunk's lines in order, context included. */
  lines: DiffLine[];
}

interface DiffFile {
  /** Repo-relative path (`src/api/rate-limit.ts`); also the file's key. */
  path: string;
  /** Tab label. Defaults to the basename. */
  name?: string;
  /** `added` and `deleted` get a badge beside the path. @default "modified" */
  change?: 'added' | 'modified' | 'deleted';
  /** Hunks in file order; a jump in line numbers between them shows as a gap row. */
  hunks: DiffHunk[];
}

/**
 * `pending` waits for the user; `approved` is being written; `written` is on disk; `rejected` was
 * sent back with feedback.
 */
type DiffReviewState = 'pending' | 'approved' | 'written' | 'rejected';

interface DiffReviewProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** The changed files, in tab order. */
  files: DiffFile[];
  /** Which face to show. @default "pending" */
  state?: DiffReviewState;
  /** Header while pending. Default `Review changes to N files`. */
  title?: ReactNode;
  /** What the change answers: the request, or the feedback this round addresses. */
  note?: ReactNode;
  /** Footer line beside the actions while pending. @default "Nothing is written until you approve." */
  hint?: ReactNode;
  /** Selected file path, controlled. */
  file?: string;
  /** Initially selected file path when uncontrolled. Defaults to the first file. */
  defaultFile?: string;
  /** Called with the path of the tab (or written-file row) the user picks. */
  onFileChange?: (path: string) => void;
  /** Unchanged lines kept on each side of a change; longer runs fold. @default 3 */
  contextLines?: number;
  /** Diff shown again in the `written` / `rejected` faces, controlled. */
  expanded?: boolean;
  /** Initial value of `expanded` each time the review folds. @default false */
  defaultExpanded?: boolean;
  /** Called when the folded header or a written-file row opens or closes the diff. */
  onExpandedChange?: (expanded: boolean) => void;
  /** Approve pressed. Omit to hide the button. */
  onApprove?: () => void;
  /** Send back pressed in the feedback form, with the trimmed note. Omit to hide Reject. */
  onReject?: (feedback: string) => void;
  /** Send back needs a note. @default true */
  requireFeedback?: boolean;
  /** Feedback shown in the `rejected` face. Defaults to the last note sent from this review. */
  feedback?: string;
  /** Feedback field placeholder. @default "What should change?" */
  feedbackPlaceholder?: string;
  /** @default "Approve" */
  approveLabel?: string;
  /** @default "Reject" */
  rejectLabel?: string;
  /** Submit label of the feedback form. @default "Send back" */
  sendLabel?: string;
  /** Write progress, 0–1, while `approved`. Omitted, the bar sweeps without a value. */
  progress?: number;
  /**
   * `card` raises the review as its own surface. `inline` is a flat block that lines up with
   * transcript rows (`ToolCallCard variant="transcript"`) in a run's step list. @default "card"
   */
  variant?: 'card' | 'inline';
  /** Density for the whole review; omitted, it inherits the nearest SizeProvider. */
  size?: SizeVariant;
  /** Localized text, names and announcements; the source English is the default.
   *  The answer buttons, hint and placeholder keep their own props. */
  labels?: Partial<DiffReviewLabels>;
}

// ─── Labels ──────────────────────────────────────────────────────────────────

interface DiffReviewLabels {
  /** Spoken line totals. */
  counts: (added: number, removed: number) => string;
  /** Spoken before a code line's text, e.g. `Added, line 5: `. */
  line: (type: DiffLineType, n?: number) => string;
  /** Fold button text. */
  showUnchanged: (count: number) => string;
  /** Fold button name, with the line range when known. */
  showUnchangedRange: (count: number, from?: number, to?: number) => string;
  /** Gap row between hunks. */
  unchanged: (count: number) => string;
  newFile: string;
  deletedFile: string;
  /** Accessible name of a written file's row. */
  showFileDiff: (path: string, added: number, removed: number) => string;
  /** Accessible name of the written file list. */
  filesChanged: string;
  /** Accessible name of the file tabs. */
  changedFiles: string;
  /** Header while pending, unless `title` is given. */
  review: (files: number) => string;
  /** Header and progress name while approved. */
  writing: (files: number) => string;
  /** Header once written. */
  wrote: (files: number) => string;
  sentBack: string;
  /** Muted after `sentBack` in the header. */
  nothingWritten: string;
  showDiff: string;
  hideDiff: string;
  approved: string;
  /** The feedback field's hidden label. */
  feedbackLabel: string;
  /** Spoken before the sent feedback. */
  feedbackPrefix: string;
  cancel: string;
  feedbackRequired: string;
  rejectCancelled: string;
  announcePending: (files: number, added: number, removed: number) => string;
  announceApproved: (files: number) => string;
  announceWritten: (files: number) => string;
  announceRejected: (feedback?: string) => string;
}

const defaultLabels: DiffReviewLabels = {
  counts: countsText,
  line: (type, n) =>
    `${type === 'add' ? 'Added' : type === 'del' ? 'Removed' : 'Unchanged'}${n !== undefined ? `, line ${n}` : ''}: `,
  showUnchanged: (n) => `Show ${plural(n, 'unchanged line')}`,
  showUnchangedRange: (n, from, to) =>
    `Show ${plural(n, 'unchanged line')}${from !== undefined && to !== undefined ? `, ${from} to ${to}` : ''}`,
  unchanged: (n) => plural(n, 'unchanged line'),
  newFile: 'New file',
  deletedFile: 'Deleted',
  showFileDiff: (path, add, del) => `Show the diff of ${path}, ${countsText(add, del)}`,
  filesChanged: 'Files changed',
  changedFiles: 'Changed files',
  review: (n) => `Review changes to ${plural(n, 'file')}`,
  writing: (n) => `Writing ${plural(n, 'file')}`,
  wrote: (n) => `Wrote ${plural(n, 'file')}`,
  sentBack: 'Sent back',
  nothingWritten: '· nothing was written',
  showDiff: 'Show the diff',
  hideDiff: 'Hide the diff',
  approved: 'Approved',
  feedbackLabel: 'What should change',
  feedbackPrefix: 'Feedback: ',
  cancel: 'Cancel',
  feedbackRequired: 'Type what should change before sending it back.',
  rejectCancelled: 'Reject cancelled. Still waiting for you.',
  announcePending: (n, add, del) =>
    `Review changes to ${plural(n, 'file')}: ${countsText(add, del)}.`,
  announceApproved: (n) => `Approved. Writing ${plural(n, 'file')}.`,
  announceWritten: (n) => `Wrote ${plural(n, 'file')}.`,
  announceRejected: (feedback) => `Sent back.${feedback ? ` ${feedback}` : ''}`,
};

const DiffLabelsContext = createContext<DiffReviewLabels>(defaultLabels);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ADD_TEXT = 'var(--success)';
const DEL_TEXT = 'var(--destructive)';
// Mixed over transparent (not toneFill's opaque mix with the page) so the tint
// keeps the panel's own surface underneath at every elevation.
const ADD_FILL = 'color-mix(in srgb, var(--success) 12%, transparent)';
const DEL_FILL = 'color-mix(in srgb, var(--destructive) 12%, transparent)';

/** Runs of unchanged lines shorter than this stay visible: folding them saves nothing. */
const MIN_FOLD = 3;

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function basename(path: string) {
  return path.slice(path.lastIndexOf('/') + 1);
}

function countLines(files: DiffFile[]) {
  let add = 0;
  let del = 0;
  for (const f of files)
    for (const h of f.hunks)
      for (const l of h.lines) {
        if (l.type === 'add') add++;
        else if (l.type === 'del') del++;
      }
  return { add, del };
}

function countsText(add: number, del: number) {
  const parts = [];
  if (add || !del) parts.push(`${add} added`);
  if (del) parts.push(`${del} removed`);
  return parts.join(', ');
}

/** First / last gutter number on the new side of a hunk (deleted lines carry the old side). */
function edgeNumber(lines: DiffLine[], from: 'start' | 'end'): number | undefined {
  const order = from === 'start' ? lines : [...lines].reverse();
  return (
    order.find((l) => l.type !== 'del' && l.n !== undefined) ?? order.find((l) => l.n !== undefined)
  )?.n;
}

type DiffRow =
  | { kind: 'line'; key: string; line: DiffLine }
  | { kind: 'fold'; key: string; lines: DiffLine[] }
  | { kind: 'gap'; key: string; count?: number; header?: string };

/**
 * Flattens a file's hunks into rows. Unchanged runs further than `context` lines from any change
 * become one expandable fold; a jump in line numbers between hunks becomes a static gap row.
 */
function buildRows(file: DiffFile, context: number): DiffRow[] {
  const rows: DiffRow[] = [];
  let prevLast: number | undefined;
  file.hunks.forEach((hunk, hi) => {
    const hk = `${hi}-${hunk.id ?? ''}`;
    const first = edgeNumber(hunk.lines, 'start');
    const from = hi === 0 ? 1 : prevLast !== undefined ? prevLast + 1 : undefined;
    const skipped = from !== undefined && first !== undefined ? first - from : 0;
    if (hunk.header || skipped > 0) {
      rows.push({
        kind: 'gap',
        key: `${hk}:gap`,
        count: skipped > 0 ? skipped : undefined,
        header: hunk.header,
      });
    }
    const changed = hunk.lines.map((l) => l.type !== 'ctx');
    const near = (i: number) => {
      for (let d = -context; d <= context; d++) if (changed[i + d]) return true;
      return false;
    };
    let run: DiffLine[] = [];
    let runStart = 0;
    const flush = () => {
      if (run.length >= MIN_FOLD) rows.push({ kind: 'fold', key: `${hk}:${runStart}`, lines: run });
      else
        run.forEach((line, j) => {
          rows.push({ kind: 'line', key: `${hk}:${runStart + j}`, line });
        });
      run = [];
    };
    hunk.lines.forEach((line, i) => {
      if (near(i)) {
        flush();
        rows.push({ kind: 'line', key: `${hk}:${i}`, line });
      } else {
        if (!run.length) runStart = i;
        run.push(line);
      }
    });
    flush();
    prevLast = edgeNumber(hunk.lines, 'end') ?? prevLast;
  });
  return rows;
}

function maxNumber(file: DiffFile) {
  let max = 0;
  for (const h of file.hunks)
    for (const l of h.lines) if (l.n !== undefined && l.n > max) max = l.n;
  return max;
}

// ─── Small parts ─────────────────────────────────────────────────────────────

/** `+15 −1` in the status hues, with a spoken version. */
function Counts({ add, del, className }: { add: number; del: number; className?: string }) {
  const labels = useContext(DiffLabelsContext);
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap tabular-nums',
        className,
      )}
    >
      <span className="sr-only">{labels.counts(add, del)}</span>
      {(add > 0 || del === 0) && (
        <span aria-hidden style={{ color: ADD_TEXT }}>
          +{add}
        </span>
      )}
      {del > 0 && (
        <span aria-hidden style={{ color: DEL_TEXT }}>
          −{del}
        </span>
      )}
    </span>
  );
}

// ─── Code ────────────────────────────────────────────────────────────────────

function CodeLine({ line, cols }: { line: DiffLine; cols: string }) {
  const size = useSize();
  const labels = useContext(DiffLabelsContext);
  const add = line.type === 'add';
  const del = line.type === 'del';
  return (
    <div
      data-type={line.type}
      className={cn('grid py-0.5 pr-4', size.type.caption)}
      style={{ gridTemplateColumns: cols, background: add ? ADD_FILL : del ? DEL_FILL : undefined }}
    >
      <span aria-hidden className="text-right text-muted-foreground tabular-nums select-none">
        {line.n}
      </span>
      <span
        aria-hidden
        className="text-center select-none"
        style={{ color: add ? ADD_TEXT : del ? DEL_TEXT : undefined }}
      >
        {add ? '+' : del ? '−' : ''}
      </span>
      <span className="whitespace-pre text-foreground [tab-size:2]">
        <span className="sr-only">{labels.line(line.type, line.n)}</span>
        {line.text || ' '}
      </span>
    </div>
  );
}

function FoldRow({ lines, cols, onOpen }: { lines: DiffLine[]; cols: string; onOpen: () => void }) {
  const size = useSize();
  const labels = useContext(DiffLabelsContext);
  const icons = useIcons();
  const Icon = icons['chevrons-up-down'];
  const from = lines[0]?.n;
  const to = lines[lines.length - 1]?.n;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={labels.showUnchangedRange(lines.length, from, to)}
      className={cn(
        'group/fold grid w-full items-center bg-muted py-1 text-left font-sans text-muted-foreground transition-colors duration-80 hover:text-foreground',
        focusRingInset,
        size.type.caption,
      )}
      style={{ gridTemplateColumns: cols }}
    >
      <span aria-hidden className="grid place-items-end">
        <Icon
          size={12}
          className="stroke-[1.5] transition-[stroke-width] duration-80 group-hover/fold:stroke-2"
        />
      </span>
      <span />
      <span>{labels.showUnchanged(lines.length)}</span>
    </button>
  );
}

function GapRow({ count, header, cols }: { count?: number; header?: string; cols: string }) {
  const size = useSize();
  const labels = useContext(DiffLabelsContext);
  const icons = useIcons();
  const Icon = icons['more-horizontal'];
  return (
    <div
      className={cn(
        'grid items-center bg-muted py-1 font-sans text-muted-foreground',
        size.type.caption,
      )}
      style={{ gridTemplateColumns: cols }}
    >
      <span aria-hidden className="grid place-items-end">
        <Icon size={12} />
      </span>
      <span />
      <span className="flex min-w-0 items-baseline gap-2 whitespace-nowrap">
        {header && <code className="font-mono">{header}</code>}
        {count !== undefined && <span>{labels.unchanged(count)}</span>}
      </span>
    </div>
  );
}

function FileCode({
  file,
  contextLines,
  openFolds,
  onOpenFold,
}: {
  file: DiffFile;
  contextLines: number;
  openFolds: Set<string>;
  onOpenFold: (key: string) => void;
}) {
  const reduce = useReducedMotion() ?? false;
  const rows = useMemo(() => buildRows(file, contextLines), [file, contextLines]);
  // At least two digits wide, so switching tabs doesn't shift the code column.
  const digits = String(Math.max(10, maxNumber(file))).length;
  const cols = `calc(${digits}ch + 0.875rem) 1.75rem auto`;
  return (
    <div className="w-max min-w-full py-1.5 font-mono">
      {rows.map((row) => {
        if (row.kind === 'line') return <CodeLine key={row.key} line={row.line} cols={cols} />;
        if (row.kind === 'gap')
          return <GapRow key={row.key} count={row.count} header={row.header} cols={cols} />;
        const id = `${file.path}|${row.key}`;
        if (!openFolds.has(id))
          return (
            <FoldRow key={row.key} lines={row.lines} cols={cols} onOpen={() => onOpenFold(id)} />
          );
        return (
          <motion.div
            key={row.key}
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={tween.moderate}
          >
            {row.lines.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: folded lines keep their order and may repeat.
              <CodeLine key={i} line={line} cols={cols} />
            ))}
          </motion.div>
        );
      })}
    </div>
  );
}

function PathRow({ file }: { file: DiffFile }) {
  const size = useSize();
  const labels = useContext(DiffLabelsContext);
  const icons = useIcons();
  const FileIcon = icons.file;
  const { add, del } = countLines([file]);
  const cut = file.path.lastIndexOf('/') + 1;
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-2 border-b border-border px-3 py-2',
        size.type.caption,
      )}
    >
      <FileIcon
        size={14}
        strokeWidth={1.5}
        aria-hidden
        className="shrink-0 text-muted-foreground"
      />
      <code className="min-w-0 truncate font-mono" title={file.path}>
        <span className="text-muted-foreground">{file.path.slice(0, cut)}</span>
        <span className="text-foreground">{file.path.slice(cut)}</span>
      </code>
      {file.change === 'added' && (
        <Badge color="green" size="compact" className="shrink-0">
          {labels.newFile}
        </Badge>
      )}
      {file.change === 'deleted' && (
        <Badge color="red" size="compact" className="shrink-0">
          {labels.deletedFile}
        </Badge>
      )}
      <Counts add={add} del={del} className="ml-auto pl-2" />
    </div>
  );
}

// ─── Written file list ───────────────────────────────────────────────────────

function FileRow({
  file,
  index,
  register,
  onOpen,
}: {
  file: DiffFile;
  index: number;
  register: (index: number, el: HTMLElement | null) => void;
  onOpen: () => void;
}) {
  const size = useSize();
  const shape = useShape();
  const icons = useIcons();
  const labels = useContext(DiffLabelsContext);
  const FileIcon = icons.file;
  const ref = useRef<HTMLLIElement>(null);
  useRegisterFluidHoverItem(register, index, ref);
  const { add, del } = countLines([file]);
  return (
    <li ref={ref} data-fluid-hover-index={index} className="relative z-10 min-w-0">
      <button
        type="button"
        onClick={onOpen}
        aria-label={labels.showFileDiff(file.path, add, del)}
        className={cn(
          'flex w-full min-w-0 items-center gap-2 px-2 py-1 text-left',
          shape.bg,
          focusRingInset,
          size.type.caption,
        )}
      >
        <FileIcon
          size={14}
          strokeWidth={1.5}
          aria-hidden
          className="shrink-0 text-muted-foreground"
        />
        <code className="min-w-0 truncate font-mono text-foreground">{file.path}</code>
        <Counts add={add} del={del} className="ml-auto pl-2" />
      </button>
    </li>
  );
}

function FileList({ files, onOpen }: { files: DiffFile[]; onOpen: (path: string) => void }) {
  const shape = useShape();
  const labels = useContext(DiffLabelsContext);
  const ref = useRef<HTMLUListElement>(null);
  const hover = useFluidHover(ref);
  return (
    <ul
      ref={ref}
      aria-label={labels.filesChanged}
      className="relative m-0 grid list-none p-0"
      {...hover.handlers}
    >
      <FluidHoverHighlight hover={hover} className={shape.bg} />
      {files.map((f, i) => (
        <FileRow
          key={f.path}
          file={f}
          index={i}
          register={hover.registerItem}
          onOpen={() => onOpen(f.path)}
        />
      ))}
    </ul>
  );
}

// ─── DiffReview ──────────────────────────────────────────────────────────────

const DiffReviewBody = forwardRef<HTMLDivElement, Omit<DiffReviewProps, 'size' | 'labels'>>(
  (
    {
      files,
      state = 'pending',
      title,
      note,
      hint = 'Nothing is written until you approve.',
      file: fileProp,
      defaultFile,
      onFileChange,
      contextLines = 3,
      expanded: expandedProp,
      defaultExpanded = false,
      onExpandedChange,
      onApprove,
      onReject,
      requireFeedback = true,
      feedback,
      feedbackPlaceholder = 'What should change?',
      approveLabel = 'Approve',
      rejectLabel = 'Reject',
      sendLabel = 'Send back',
      progress,
      variant = 'card',
      className,
      ...props
    },
    ref,
  ) => {
    const size = useSize();
    const shape = useShape();
    const icons = useIcons();
    const labels = useContext(DiffLabelsContext);
    const reduce = useReducedMotion() ?? false;
    const uid = useId();
    const titleId = `${uid}-title`;
    const bodyId = `${uid}-body`;
    const inline = variant === 'inline';
    const compact = size.variant === 'compact';

    const total = countLines(files);
    const fileCount = files.length;
    const folded = state === 'written' || state === 'rejected';

    // Selected file.
    const [activePath, selectFile] = useControllable(
      fileProp,
      defaultFile ?? files[0]?.path ?? '',
      onFileChange,
    );
    const activeIndex = Math.max(
      0,
      files.findIndex((f) => f.path === activePath),
    );
    const active = files[activeIndex];
    // Tab switches slide in from the side they came from.
    const lastIndex = useRef(activeIndex);
    const direction =
      activeIndex === lastIndex.current ? 0 : activeIndex > lastIndex.current ? 1 : -1;
    useEffect(() => {
      lastIndex.current = activeIndex;
    }, [activeIndex]);

    // Diff reopened in the folded faces; reset each time the review folds.
    const [expandedState, setExpandedState] = useState(defaultExpanded);
    const expanded = expandedProp ?? expandedState;
    const setExpanded = (next: boolean) => {
      if (expandedProp === undefined) setExpandedState(next);
      onExpandedChange?.(next);
    };
    // Only on entering a folded face.
    // biome-ignore lint/correctness/useExhaustiveDependencies: a state change alone resets the reopened diff.
    useEffect(() => {
      if (expandedProp === undefined && folded) setExpandedState(defaultExpanded);
    }, [state]);
    const bodyOpen = !folded || expanded;

    const [openFolds, setOpenFolds] = useState<Set<string>>(() => new Set());
    const openFold = (key: string) => setOpenFolds((s) => new Set(s).add(key));

    // Feedback form.
    const [composing, setComposing] = useState(false);
    const [draft, setDraft] = useState('');
    const [error, setError] = useState<string | undefined>();
    const [sent, setSent] = useState<string | undefined>();
    const showForm = composing && state === 'pending';
    const feedbackText = feedback ?? sent;

    // Live region: state changes after mount, validation, cancel.
    const [said, setSaid] = useState('');
    const prevState = useRef(state);
    // biome-ignore lint/correctness/useExhaustiveDependencies: only a state change is announced.
    useEffect(() => {
      if (prevState.current === state) return;
      prevState.current = state;
      setSaid(
        state === 'pending'
          ? labels.announcePending(fileCount, total.add, total.del)
          : state === 'approved'
            ? labels.announceApproved(fileCount)
            : state === 'written'
              ? labels.announceWritten(fileCount)
              : labels.announceRejected(feedbackText),
      );
    }, [state]);

    // Focus: after an answer the pressed button is gone, so focus moves to the
    // header toggle (folded faces) or the review itself instead of the page.
    const rootRef = useRef<HTMLDivElement>(null);
    const toggleRef = useRef<HTMLButtonElement>(null);
    const rejectRef = useRef<HTMLButtonElement>(null);
    const focusAfter = useRef<'answer' | 'reject' | null>(null);
    useEffect(() => {
      const target = focusAfter.current;
      if (!target) return;
      if (target === 'reject') {
        if (!showForm) {
          focusAfter.current = null;
          rejectRef.current?.focus();
        }
        return;
      }
      if (state === 'pending') return;
      focusAfter.current = null;
      (toggleRef.current ?? rootRef.current)?.focus({ preventScroll: true });
    }, [state, showForm]);

    const approve = () => {
      focusAfter.current = 'answer';
      onApprove?.();
    };
    const openForm = () => {
      setError(undefined);
      setComposing(true);
    };
    const cancel = () => {
      setComposing(false);
      setError(undefined);
      focusAfter.current = 'reject';
      setSaid(labels.rejectCancelled);
    };
    const submit = (e: FormEvent) => {
      e.preventDefault();
      const text = draft.trim();
      if (!text && requireFeedback) {
        const message = labels.feedbackRequired;
        setError(message);
        setSaid(message);
        return;
      }
      setSent(text);
      setDraft('');
      setComposing(false);
      focusAfter.current = 'answer';
      onReject?.(text);
    };
    const onFormKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };

    const openFile = (path: string) => {
      selectFile(path);
      setExpanded(true);
    };

    // ── Header ──
    const ListChecks = icons['list-checks'];
    const Restart = icons['rotate-ccw'];
    const headIcon =
      state === 'pending' ? (
        <span className="pulse-soft grid place-items-center" style={{ color: 'var(--warning)' }}>
          <ListChecks size={16} strokeWidth={1.5} />
        </span>
      ) : state === 'approved' ? (
        <AgentStatusIcon status="running" size={14} />
      ) : state === 'written' ? (
        <DrawnCheck style={{ color: 'var(--success)' }} />
      ) : (
        <Restart size={15} strokeWidth={1.5} className="text-muted-foreground" />
      );
    const headText =
      state === 'pending' ? (
        (title ?? labels.review(fileCount))
      ) : state === 'approved' ? (
        <span className="shimmer-text">{labels.writing(fileCount)}</span>
      ) : state === 'written' ? (
        labels.wrote(fileCount)
      ) : (
        <>
          {labels.sentBack} <span className="text-muted-foreground">{labels.nothingWritten}</span>
        </>
      );

    const headPad = inline
      ? compact
        ? 'min-h-9 px-2 py-1.5'
        : 'min-h-10 px-2.5 py-2'
      : compact
        ? 'px-3 py-2.5'
        : 'px-3.5 py-3';
    const bodyPad = inline
      ? cn('pr-2.5 pb-2 @max-[480px]:pl-2.5', compact ? 'pl-8' : 'pl-9')
      : compact
        ? 'px-3 pb-3'
        : 'px-3.5 pb-3.5';
    const listPad = inline
      ? cn('pr-0.5 pb-1 @max-[480px]:pl-0.5', compact ? 'pl-6' : 'pl-7')
      : compact
        ? 'px-1 pb-1.5'
        : 'px-1.5 pb-2';
    const enter = reduce ? false : { opacity: 0, y: 4 };

    const header = (
      <div
        className={cn(
          'relative grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-2.5',
          headPad,
        )}
      >
        {folded && (
          <button
            ref={toggleRef}
            type="button"
            aria-expanded={expanded}
            aria-controls={bodyId}
            aria-labelledby={titleId}
            aria-describedby={`${uid}-toggle`}
            onClick={() => setExpanded(!expanded)}
            className={cn(
              'absolute inset-0 transition-colors duration-80 hover:bg-hover',
              shape.bg,
              focusRingInset,
            )}
          />
        )}
        <span aria-hidden className="pointer-events-none relative grid h-5 place-items-center">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={state}
              className="grid place-items-center"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6, transition: spring.fast.exit }}
              transition={spring.slow}
            >
              {headIcon}
            </motion.span>
          </AnimatePresence>
        </span>
        <span
          id={titleId}
          className={cn(
            'pointer-events-none relative grid min-w-0 text-foreground',
            size.type.body,
          )}
        >
          <Roll id={state} innerClassName="truncate">
            {headText}
          </Roll>
        </span>
        <span
          className={cn('pointer-events-none relative flex items-center gap-2', size.type.caption)}
        >
          <Counts add={total.add} del={total.del} />
          {folded && (
            <>
              <span id={`${uid}-toggle`} className="sr-only">
                {expanded ? labels.hideDiff : labels.showDiff}
              </span>
              <DisclosureChevron open={expanded} />
            </>
          )}
        </span>
      </div>
    );

    // ── Footer ──
    const footer = (
      <div className="border-t border-border py-2 pr-2 pl-3">
        <AnimatePresence initial={false} mode="popLayout">
          {state === 'approved' || state === 'written' ? (
            <motion.div
              key="writing"
              className={cn('flex w-full items-center gap-3', size.control)}
              initial={enter}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: spring.moderate.exit }}
              transition={spring.moderate}
            >
              <span
                className={cn(
                  'inline-flex min-w-0 flex-1 items-center gap-1.5 text-foreground',
                  size.type.body,
                )}
              >
                <AgentStatusIcon status="done" size={14} />
                {labels.approved}
              </span>
              {state === 'approved' && (
                // Without a value the bar fills at half strength and reports no number.
                <Meter
                  live
                  value={progress ?? 1}
                  color="var(--emphasis)"
                  label={labels.writing(fileCount)}
                  aria-valuenow={
                    progress === undefined
                      ? undefined
                      : Math.round(Math.max(0, Math.min(1, progress)) * 100)
                  }
                  className={cn(
                    'w-24 shrink-0 *:transition-opacity *:duration-240',
                    progress === undefined && '*:opacity-50',
                  )}
                />
              )}
            </motion.div>
          ) : state === 'rejected' ? (
            <motion.div
              key="sent"
              className={cn(
                'flex w-full items-center gap-1.5 text-muted-foreground',
                size.control,
                size.type.body,
              )}
              initial={enter}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: spring.moderate.exit }}
              transition={spring.moderate}
            >
              <Restart size={14} strokeWidth={1.5} aria-hidden />
              {labels.sentBack}
            </motion.div>
          ) : showForm ? (
            <motion.form
              key="form"
              noValidate
              onSubmit={submit}
              onKeyDown={onFormKeyDown}
              className="flex w-full flex-wrap items-start gap-2"
              initial={enter}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: spring.moderate.exit }}
              transition={spring.moderate}
            >
              <InputGroup className="w-auto min-w-[min(100%,12rem)] flex-1">
                <InputField
                  index={0}
                  label={labels.feedbackLabel}
                  labelHidden
                  placeholder={feedbackPlaceholder}
                  value={draft}
                  onChange={(v) => {
                    setDraft(v);
                    if (error) setError(undefined);
                  }}
                  error={error}
                  autoFocus
                  autoComplete="off"
                />
              </InputGroup>
              <div className="ml-auto flex shrink-0 gap-2 @max-[440px]:w-full @max-[440px]:[&>*]:flex-1">
                <Button type="button" variant="tertiary" onClick={cancel}>
                  {labels.cancel}
                </Button>
                <Button type="submit" variant="primary">
                  {sendLabel}
                </Button>
              </div>
            </motion.form>
          ) : (
            <motion.div
              key="ask"
              className="flex w-full flex-wrap items-center gap-x-3 gap-y-2"
              initial={enter}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: spring.moderate.exit }}
              transition={spring.moderate}
            >
              <p
                className={cn(
                  'm-0 min-w-0 flex-1 text-muted-foreground @max-[440px]:order-2',
                  size.type.body,
                )}
              >
                {hint}
              </p>
              {(onReject || onApprove) && (
                <div className="ml-auto flex shrink-0 gap-2 @max-[440px]:order-1 @max-[440px]:w-full @max-[440px]:[&>*]:flex-1">
                  {onReject && (
                    <Button ref={rejectRef} variant="tertiary" onClick={openForm}>
                      {rejectLabel}
                    </Button>
                  )}
                  {onApprove && (
                    <Button variant="primary" onClick={approve}>
                      {approveLabel}
                    </Button>
                  )}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );

    // ── Diff panel ──
    const panelId = files.length > 1 ? `${uid}-panel-${activeIndex}` : `${uid}-panel`;
    const panel = active && (
      <div className={cn('relative overflow-hidden border border-border', shape.container)}>
        {files.length > 1 && (
          <div className="border-b border-border px-2 py-1.5">
            <TabsSubtle
              selectedIndex={activeIndex}
              onSelect={(i) => selectFile((files[i] as DiffFile).path)}
              idPrefix={uid}
              aria-label={labels.changedFiles}
            >
              {files.map((f, i) => (
                <TabsSubtleItem key={f.path} index={i} label={f.name ?? basename(f.path)} />
              ))}
            </TabsSubtle>
          </div>
        )}
        <div className="relative">
          <AnimatePresence initial={false} mode="popLayout" custom={direction}>
            <motion.div
              key={active.path}
              custom={direction}
              initial={reduce ? false : { opacity: 0, x: direction * 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, transition: tween.fast.exit }}
              transition={spring.moderate}
            >
              <PathRow file={active} />
              <ScrollArea
                orientation="horizontal"
                id={panelId}
                role={files.length > 1 ? 'tabpanel' : 'region'}
                aria-labelledby={files.length > 1 ? `${uid}-tab-${activeIndex}` : undefined}
                aria-label={files.length > 1 ? undefined : active.path}
                tabIndex={0}
                className={focusRingInset}
              >
                <FileCode
                  file={active}
                  contextLines={contextLines}
                  openFolds={openFolds}
                  onOpenFold={openFold}
                />
              </ScrollArea>
            </motion.div>
          </AnimatePresence>
        </div>
        {/* Kept while the review folds so the panel shrinks in one motion; a diff reopened
            after the answer is read-only and has no footer. */}
        {(!folded || !expanded) && footer}
      </div>
    );

    const Frame = inline ? 'div' : AgentCard;
    return (
      <Frame
        ref={(node: HTMLDivElement | null) => {
          rootRef.current = node;
          assignRef(ref, node);
        }}
        role="group"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-state={state}
        data-variant={variant}
        className={cn('@container min-w-0 outline-none', size.type.body, className)}
        {...props}
      >
        <span className="sr-only" role="status" aria-live="polite">
          {said}
        </span>
        {header}
        <AnimatePresence initial={false}>
          {state === 'rejected' && feedbackText && (
            <motion.p
              key="feedback"
              className={cn('m-0', bodyPad)}
              initial={reduce ? false : { opacity: 0, y: -2 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: spring.moderate.exit }}
              transition={spring.moderate}
            >
              <span
                className={cn(
                  'block border-l-2 border-border pl-2.5 whitespace-pre-line text-muted-foreground [overflow-wrap:anywhere]',
                  size.type.caption,
                )}
              >
                <span className="sr-only">{labels.feedbackPrefix}</span>
                {feedbackText}
              </span>
            </motion.p>
          )}
        </AnimatePresence>
        <Collapse open={state === 'written' && !expanded}>
          <div className={listPad}>
            <FileList files={files} onOpen={openFile} />
          </div>
        </Collapse>
        <Collapse open={bodyOpen} id={bodyId}>
          <div className={cn('grid gap-3', bodyPad)}>
            {note !== undefined && note !== null && note !== '' && (
              <p
                className={cn(
                  'm-0 max-w-[60ch] text-muted-foreground [overflow-wrap:anywhere]',
                  size.type.body,
                )}
              >
                {note}
              </p>
            )}
            {panel}
          </div>
        </Collapse>
      </Frame>
    );
  },
);
DiffReviewBody.displayName = 'DiffReviewBody';

/** A diff the agent wants to write: file tabs, tinted hunks with folded context, Reject / Approve. */
const DiffReview = forwardRef<HTMLDivElement, DiffReviewProps>(
  ({ size, labels: labelOverrides, ...props }, ref) => {
    const labels = useMemo(() => ({ ...defaultLabels, ...labelOverrides }), [labelOverrides]);
    return (
      <SizeScope size={size}>
        <DiffLabelsContext.Provider value={labels}>
          <DiffReviewBody ref={ref} {...props} />
        </DiffLabelsContext.Provider>
      </SizeScope>
    );
  },
);
DiffReview.displayName = 'DiffReview';

export type {
  DiffFile,
  DiffHunk,
  DiffLine,
  DiffLineType,
  DiffReviewLabels,
  DiffReviewProps,
  DiffReviewState,
};
export { DiffReview };
