'use client';

import { AnimatePresence, motion, Reorder, useReducedMotion } from 'motion/react';
import {
  type ChangeEvent,
  forwardRef,
  type HTMLAttributes,
  type DragEvent as ReactDragEvent,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  type TextareaHTMLAttributes,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useFluidHover, useRegisterFluidHoverItem } from '../../hooks/use-fluid-hover.ts';
import { focusRing, focusRingInset } from '../../lib/focus.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { useIcons } from '../../lib/icon-context.tsx';
import { omit } from '../../lib/omit.ts';
import { nestedRadius, useShape } from '../../lib/shape-context.tsx';
import {
  fieldTouchClass,
  SizeProvider,
  type SizeVariant,
  useSize,
} from '../../lib/size-context.tsx';
import { spring } from '../../lib/springs.ts';
import { surfaceClasses } from '../../lib/surface-classes.ts';
import { SurfaceProvider } from '../../lib/surface-context.tsx';
import { cn } from '../../lib/utils.ts';
import { Button } from './button.tsx';
import { FileThumbnail } from './file-thumbnail.tsx';
import { FluidHoverHighlight } from './fluid-hover-highlight.tsx';
import { Tooltip } from './tooltip.tsx';

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Pixel height for a collapsible region. Not `height: "auto"`: framer resolves
 * "auto" from the transformed size, so a scaled ancestor makes it balloon.
 * The ref goes on the region's CONTENT; the reported height is the clipping
 * parent's scrollHeight (margins included), and observing the child keeps the
 * ResizeObserver out of a feedback loop with the animation.
 */
function useRegionHeight() {
  const roRef = useRef<ResizeObserver | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el) return;
    const sync = () => {
      const next = el.parentElement?.scrollHeight ?? el.offsetHeight;
      if (next > 0) setHeight(next);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    roRef.current = ro;
  }, []);
  return [ref, height] as const;
}

// `(hover: none)`: show hover-revealed affordances persistently. False on SSR.
function useIsTouch() {
  const [isTouch, setIsTouch] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(hover: none)');
    const update = () => setIsTouch(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return isTouch;
}

const DEFAULT_ACCEPT = 'image/png,image/jpeg,image/webp';

interface InputMessageSlotContext {
  /** Opens the native file picker; `acceptOverride` (e.g. `"image/*"`)
   *  narrows the accepted types for this call only. */
  openFilePicker: (acceptOverride?: string) => void;
  /** Currently-attached files (controlled). */
  files: File[];
}

type InputMessageSlot = ReactNode | ((ctx: InputMessageSlotContext) => ReactNode);

/** Calls a function slot in its own component, so consumer code never gets
 *  the ref-reading callbacks during InputMessage's render. */
function InputMessageSlotContent({
  slot,
  ctx,
}: {
  slot: InputMessageSlot;
  ctx: InputMessageSlotContext;
}) {
  return <>{typeof slot === 'function' ? slot(ctx) : slot}</>;
}

/** A message queued while the assistant responds: trimmed text plus the files
 *  attached at the time. `id` is a stable key minted on enqueue. */
interface QueuedMessage {
  id: string;
  text: string;
  files: File[];
}

type InputMessageInputProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  ref: RefObject<HTMLTextAreaElement | null>;
};

interface InputMessageProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  /** Size step for the whole composer. Wins over the surrounding SizeProvider. */
  size?: SizeVariant;
  /** Host-owned textarea ref, for command/mention caret and focus restoration. */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** Host input semantics; the kit still supplies its field layout and focus callbacks. */
  renderInput?: (props: InputMessageInputProps) => ReactNode;
  /** Validated attachments, context and notices rendered before the input. */
  contentSlot?: ReactNode;
  /** Blocks submission without disabling editing or the host's recovery controls. */
  sendDisabled?: boolean;
  sendDescription?: string;
  /** Adds the host's tooltip without replacing the source send button. */
  renderAction?: (action: ReactElement<{ 'aria-describedby'?: string }>) => ReactNode;
  /** Controlled textarea value. */
  value: string;
  /** Called with the new value on every textarea change. */
  onValueChange: (value: string) => void;
  /** Fired on submit and when a queued message auto-dispatches (then with
   *  `meta.queuedId`, e.g. for a shared `layoutId` transition). */
  onSend?: (value: string, files: File[], meta?: { queuedId?: string }) => void;
  placeholder?: string;
  /** Bottom-left actions. A function receives `{ openFilePicker, files }`. */
  leftSlot?: InputMessageSlot;
  /** Bottom-right actions, before the send button. Same shape as leftSlot. */
  rightSlot?: InputMessageSlot;
  /** Disables the textarea, send button, and drag-and-drop. */
  disabled?: boolean;
  /** Minimum visible rows before the textarea grows. */
  minRows?: number;
  /** Maximum visible rows before the textarea starts to scroll. */
  maxRows?: number;
  /** When false, clicking the surrounding container won't refocus the textarea. */
  clickToFocus?: boolean;
  /** Accessible label for the send button. */
  sendLabel?: string;
  /** Controlled attached files. Attachments are enabled by `onFilesChange`. */
  files?: File[];
  onFilesChange?: (files: File[]) => void;
  /** Comma-separated MIME types. Defaults to PNG / JPEG / PDF. */
  accept?: string;
  /** Files past the limit are dropped. */
  maxFiles?: number;
  /** Preview tile side in px. Defaults to 80. */
  filePreviewSize?: number;
  textareaProps?: Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    'value' | 'onChange' | 'onKeyDown' | 'disabled' | 'placeholder'
  >;
  /** While `"streaming"`, send becomes Stop (empty draft) or Queue; on
   *  `streaming → idle` the next queued message dispatches. Omit to always send. */
  status?: 'idle' | 'streaming';
  /** Stop pressed: halt the response and set `status` to `"idle"`. */
  onStop?: () => void;
  /** Controlled queue of pending messages. Requires `status` to be controlled. */
  queue?: QueuedMessage[];
  onQueueChange?: (queue: QueuedMessage[]) => void;
  /** `false` hides the built-in queue rows; enqueue and dispatch still run. */
  showQueue?: boolean;
  /** Sent messages, oldest first. ArrowUp on the first line / ArrowDown on
   *  the last line walk through them, readline-style. */
  history?: string[];
  /** Placeholder with a Tab keycap; Tab fills it in (doesn't send). */
  placeholderSuggestion?: string;
  /** Prompts listed under the action bar while the draft is empty; arrows
   *  highlight, Enter or click fills the composer. */
  suggestions?: string[];
}

// ─── File preview tile ───────────────────────────────────────────────────────
interface FilePreviewTileProps {
  file: File;
  onRemove: () => void;
  size: number;
}

function FilePreviewTile({ file, onRemove, size }: FilePreviewTileProps) {
  const icons = useIcons();
  const XIcon = icons.x;
  const shape = useShape();
  // The tile sits 8px inside the composer's edge.
  const radius = nestedRadius(shape.containerRadius, 8);

  return (
    <motion.div
      // `layout` slides siblings into the gap when a tile is removed.
      layout
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9, transition: spring.fast.exit }}
      transition={spring.fast}
      // Opts out of the parent's `cursor-text`.
      className="relative shrink-0 cursor-default group/tile"
    >
      <FileThumbnail file={file} size={size} radius={radius} />
      <Tooltip content="Remove" side="top">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label={`Remove ${file.name}`}
          // Solid foreground badge (inverts with the theme): it must read over arbitrary content.
          className={cn(
            'absolute top-1 right-1 w-5 h-5 rounded-full bg-foreground text-background opacity-0 group-hover/tile:opacity-100 transition-opacity duration-80 flex items-center justify-center cursor-pointer focus-visible:opacity-100',
            focusRing,
          )}
        >
          <XIcon size={12} strokeWidth={2.5} />
        </button>
      </Tooltip>
    </motion.div>
  );
}

// ─── Queued message row ──────────────────────────────────────────────────────
// Double-click / Enter / F2 edits, × / Delete removes, drag / Alt+↑↓
// reorders. The top row dispatches next.
interface QueuedRowProps {
  item: QueuedMessage;
  index: number;
  total: number;
  reduceMotion: boolean;
  isTouch: boolean;
  onEdit: (item: QueuedMessage) => void;
  onRemove: (item: QueuedMessage) => void;
  onMove: (item: QueuedMessage, dir: -1 | 1) => void;
}

function QueuedRow({
  item,
  index,
  total,
  reduceMotion,
  isTouch,
  onEdit,
  onRemove,
  onMove,
}: QueuedRowProps) {
  const icons = useIcons();
  const XIcon = icons.x;
  const ImageIcon = icons.image;
  const compactStep = useSize().variant === 'compact';
  const fileCount = item.files.length;
  const label = item.text || `${fileCount} attachment${fileCount === 1 ? '' : 's'}`;

  return (
    <Reorder.Item
      value={item}
      layout
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={
        reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, transition: spring.fast.exit }
      }
      transition={spring.fast}
      aria-label={`Queued message ${index + 1} of ${total}: ${label}`}
      tabIndex={0}
      onDoubleClick={() => onEdit(item)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'F2') {
          e.preventDefault();
          onEdit(item);
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          onRemove(item);
        } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          onMove(item, e.key === 'ArrowUp' ? -1 : 1);
        }
      }}
      className={cn(
        // Fixed height so the label's text-box trim doesn't shrink the row.
        'group/qrow flex items-center gap-2 rounded-lg bg-muted',
        compactStep
          ? 'h-7 px-2 text-[length:var(--fs-body-compact,12px)] leading-[var(--lh-body-compact,18px)]'
          : 'h-8 px-2.5 text-[length:var(--fs-body,13px)] leading-[var(--lh-body,20px)]',
        'text-foreground select-none',
        'cursor-grab active:cursor-grabbing',
        focusRingInset,
      )}
      style={{ fontVariationSettings: fontWeights.normal }}
    >
      {fileCount > 0 && (
        <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
          <ImageIcon size={13} />
          {item.text && <span className="tabular-nums">{fileCount}</span>}
        </span>
      )}
      {/* py-1/-my-1: truncate's overflow would clip the trimmed glyphs. */}
      <span className="min-w-0 flex-1 truncate [text-box:trim-both_cap_alphabetic] py-1 -my-1">
        {label}
      </span>
      <Tooltip content="Remove" side="top">
        <button
          type="button"
          // Don't start a drag or reach the row's edit handler.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onRemove(item);
          }}
          aria-label={`Remove queued message: ${label}`}
          className={cn(
            'shrink-0 flex h-5 w-5 items-center justify-center rounded-full',
            'text-muted-foreground hover:text-foreground hover:bg-hover',
            isTouch
              ? 'opacity-100'
              : 'opacity-0 group-hover/qrow:opacity-100 focus-visible:opacity-100',
            'transition-opacity duration-80 cursor-pointer',
            focusRing,
          )}
        >
          <XIcon size={13} strokeWidth={2.5} />
        </button>
      </Tooltip>
    </Reorder.Item>
  );
}

// ─── Suggestion row ──────────────────────────────────────────────────────────
// Registers in an effect: an inline ref callback would re-register every
// render and the measurement pass would never settle.
interface SuggestionRowProps {
  text: string;
  index: number;
  active: boolean;
  /** Show a ↓ hint: ArrowDown enters the list. */
  keyHint: boolean;
  optionId: string;
  registerItem: (index: number, element: HTMLElement | null) => void;
  onSelect: () => void;
}

function SuggestionRow({
  text,
  index,
  active,
  keyHint,
  optionId,
  registerItem,
  onSelect,
}: SuggestionRowProps) {
  const icons = useIcons();
  const EnterIcon = icons['corner-down-left'];
  const ArrowDownIcon = icons['arrow-down'];
  const compactStep = useSize().variant === 'compact';
  const ref = useRef<HTMLDivElement>(null);

  useRegisterFluidHoverItem(registerItem, index, ref);

  return (
    // biome-ignore lint/a11y/useFocusableInteractive: focus stays in the input and aria-activedescendant identifies this option.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the input owns arrow and Enter handling for the suggestion list.
    <div
      ref={ref}
      id={optionId}
      role="option"
      aria-selected={active}
      onClick={onSelect}
      className={cn(
        'relative flex cursor-pointer items-center gap-2',
        // Text matches the textarea; heights match QueuedRow.
        compactStep
          ? 'h-7 px-2 text-[length:var(--fs-subtitle-compact,13px)] leading-[var(--lh-subtitle-compact,18px)]'
          : 'h-8 px-2.5 text-[length:var(--fs-subtitle,14px)] leading-[var(--lh-subtitle,20px)]',
        'text-muted-foreground transition-colors duration-80',
        active && 'text-foreground',
      )}
      style={{ fontVariationSettings: fontWeights.normal }}
    >
      {/* py-1/-my-1: truncate's overflow would clip the trimmed glyphs. */}
      <span className="min-w-0 flex-1 truncate [text-box:trim-both_cap_alphabetic] py-1 -my-1">
        {text}
      </span>
      {/* One icon slot: ↵ when highlighted, else ↓ on the key-hint row. */}
      {!active && keyHint ? (
        <ArrowDownIcon
          size={13}
          className="shrink-0 text-muted-foreground transition-opacity duration-80"
        />
      ) : (
        <EnterIcon
          size={13}
          className={cn(
            'shrink-0 transition-opacity duration-80',
            active ? 'opacity-100' : 'opacity-0',
          )}
        />
      )}
    </div>
  );
}

// ─── InputMessage ────────────────────────────────────────────────────────────

const InputMessage = forwardRef<HTMLDivElement, InputMessageProps>(
  (
    {
      size,
      inputRef,
      renderInput,
      contentSlot,
      sendDisabled,
      sendDescription,
      renderAction,
      value,
      onValueChange,
      onSend,
      placeholder = 'Ask me anything…',
      leftSlot,
      rightSlot,
      disabled,
      minRows = 1,
      maxRows = 8,
      clickToFocus = true,
      sendLabel = 'Send',
      files,
      onFilesChange,
      accept = DEFAULT_ACCEPT,
      maxFiles,
      filePreviewSize = 80,
      textareaProps,
      status,
      onStop,
      queue,
      onQueueChange,
      showQueue = true,
      history = [],
      placeholderSuggestion,
      suggestions,
      className,
      style,
      ...props
    },
    ref,
  ) => {
    const shape = useShape();
    const compactStep = useSize(size).variant === 'compact';
    const icons = useIcons();
    const ArrowUpIcon = icons['arrow-up'];
    const reduceMotion = useReducedMotion() ?? false;
    const isTouch = useIsTouch();

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(inputRef, () => textareaRef.current as HTMLTextAreaElement);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [focusVisible, setFocusVisible] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const [hovered, setHovered] = useState(false);

    // Split out so the spread can't clobber the composed handlers and classes.
    const {
      'aria-describedby': textareaDescribedBy,
      className: textareaClassName,
      ...textareaRest
    } = textareaProps ?? {};
    const restTextareaProps = omit(textareaRest, ['onFocus', 'onBlur']);

    const filesArr = useMemo(() => files ?? [], [files]);
    const supportsFiles = onFilesChange !== undefined;

    const queueArr = useMemo(() => queue ?? [], [queue]);
    // Latest queue, for two edits landing before the prop round-trips.
    const queueRef = useRef(queueArr);
    useIsoLayoutEffect(() => {
      queueRef.current = queueArr;
    });
    const supportsQueue = status !== undefined && onQueueChange !== undefined;
    const streaming = status === 'streaming';
    const [liveMsg, setLiveMsg] = useState('');

    // `historyIndex` is null when not browsing; the draft is restored past the
    // newest entry.
    const [historyIndex, setHistoryIndex] = useState<number | null>(null);
    const draftBeforeHistory = useRef('');

    // Focus stays in the textarea (aria-activedescendant); pointer and arrows
    // drive the same fluid-hover highlight.
    const suggestionsArr = useMemo(() => suggestions ?? [], [suggestions]);
    const suggestionsOpen = suggestionsArr.length > 0 && value === '';
    const suggestionListRef = useRef<HTMLDivElement>(null);
    const [filesRegionRef, filesRegionHeight] = useRegionHeight();
    const [queueRegionRef, queueRegionHeight] = useRegionHeight();
    const [suggestionsRegionRef, suggestionsRegionHeight] = useRegionHeight();
    const suggestionHover = useFluidHover(suggestionListRef);
    const {
      activeIndex: activeSuggestion,
      setActiveIndex: setActiveSuggestion,
      handlers: suggestionHandlers,
      registerItem: registerSuggestion,
      remeasure,
    } = suggestionHover;

    // Rects measured while closed are stale: re-measure on open.
    useEffect(() => {
      if (suggestionsOpen) remeasure();
    }, [suggestionsOpen, remeasure]);
    const suggestionListId = useId();
    const ghostHintId = useId();
    const showGhost = !!placeholderSuggestion && value === '' && !(dragOver && supportsFiles);

    useEffect(() => {
      if (!suggestionsOpen) setActiveSuggestion(null);
    }, [suggestionsOpen, setActiveSuggestion]);

    // Fills only; the user still sends.
    const acceptSuggestion = useCallback(
      (text: string) => {
        setActiveSuggestion(null);
        setHistoryIndex(null);
        onValueChange(text);
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        });
      },
      [onValueChange, setActiveSuggestion],
    );

    // Cached to skip getComputedStyle on every keystroke.
    const lineHeightCache = useRef<{ el: HTMLTextAreaElement; value: number } | null>(null);

    const resizeTextarea = useCallback(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = 'auto';
      let cache = lineHeightCache.current;
      if (!cache || cache.el !== el) {
        const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
        cache = { el, value: Number.isNaN(lineHeight) ? 20 : lineHeight };
        lineHeightCache.current = cache;
      }
      const min = cache.value * minRows;
      const max = cache.value * maxRows;
      const next = Math.min(Math.max(el.scrollHeight, min), max);
      el.style.height = `${next}px`;
      el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
    }, [minRows, maxRows]);

    useIsoLayoutEffect(() => {
      resizeTextarea();
    }, [value, resizeTextarea]);

    // Re-measure on width change: a mount at near-zero width would pin the
    // height at maxRows. Width-gated so height writes don't loop.
    useEffect(() => {
      const el = textareaRef.current;
      if (!el || typeof ResizeObserver === 'undefined') return;
      let lastWidth = el.offsetWidth;
      const ro = new ResizeObserver(() => {
        const width = el.offsetWidth;
        if (width === lastWidth) return;
        lastWidth = width;
        resizeTextarea();
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, [resizeTextarea]);

    const trimmed = value.trim();
    const canSend = !disabled && !sendDisabled && (trimmed.length > 0 || filesArr.length > 0);

    // The edge is the box-shadow's 1px ring, recolored per state (drag > focus
    // > hover) so it never looks thicker. Inline because Tailwind `shadow-*`
    // mangles multi-layer values; at rest `shadow-surface-2` applies.
    const EDGE_DROP = '0 1px 1px -0.5px var(--shadow-color)';
    const edgeShadow = dragOver
      ? `0 0 0 1px var(--emphasis), ${EDGE_DROP}`
      : focusVisible
        ? `0 0 0 1px color-mix(in oklab, var(--foreground) 20%, transparent), ${EDGE_DROP}`
        : hovered && clickToFocus && !disabled
          ? `0 0 0 1px var(--border), ${EDGE_DROP}`
          : undefined;

    const handleSend = useCallback(() => {
      if (!canSend) return;
      setHistoryIndex(null);
      // While streaming, a submit enqueues the draft instead.
      if (streaming && supportsQueue) {
        const item: QueuedMessage = {
          id: crypto.randomUUID(),
          text: trimmed,
          files: filesArr,
        };
        onQueueChange?.([...queueRef.current, item]);
        onValueChange('');
        if (supportsFiles) onFilesChange?.([]);
        requestAnimationFrame(() => textareaRef.current?.focus());
        return;
      }
      onSend?.(trimmed, filesArr);
    }, [
      canSend,
      streaming,
      supportsQueue,
      onSend,
      trimmed,
      filesArr,
      onQueueChange,
      onValueChange,
      supportsFiles,
      onFilesChange,
    ]);

    const handleStop = useCallback(() => onStop?.(), [onStop]);

    // On streaming → idle, dispatch the queue head. The consumer sets status
    // back to "streaming" in onSend, re-arming this for the next item.
    const prevStatusRef = useRef(status);
    useEffect(() => {
      const prev = prevStatusRef.current;
      prevStatusRef.current = status;
      if (!supportsQueue) return;
      if (prev === 'streaming' && status === 'idle' && queueArr.length > 0) {
        const [next, ...rest] = queueArr as [QueuedMessage, ...QueuedMessage[]];
        onQueueChange?.(rest);
        onSend?.(next.text, next.files, { queuedId: next.id });
        setLiveMsg(`Message sent.${rest.length ? ` ${rest.length} still queued.` : ''}`);
      }
    }, [status, supportsQueue, queueArr, onQueueChange, onSend]);

    // ─── Queue item actions ──────────────────────────────────────────────────
    const editQueued = useCallback(
      (item: QueuedMessage) => {
        if (!supportsQueue) return;
        // Replaces the current draft; re-sending queues it at the end.
        setHistoryIndex(null);
        onValueChange(item.text);
        if (supportsFiles) {
          onFilesChange?.(maxFiles != null ? item.files.slice(0, maxFiles) : item.files);
        }
        onQueueChange?.(queueRef.current.filter((q) => q.id !== item.id));
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        });
      },
      [supportsQueue, supportsFiles, onValueChange, onFilesChange, maxFiles, onQueueChange],
    );

    const removeQueued = useCallback(
      (item: QueuedMessage) => onQueueChange?.(queueRef.current.filter((q) => q.id !== item.id)),
      [onQueueChange],
    );

    const moveQueued = useCallback(
      (item: QueuedMessage, dir: -1 | 1) => {
        const cur = queueRef.current;
        const i = cur.findIndex((q) => q.id === item.id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= cur.length) return;
        const next = [...cur];
        [next[i], next[j]] = [next[j] as QueuedMessage, next[i] as QueuedMessage];
        onQueueChange?.(next);
      },
      [onQueueChange],
    );

    // Send and Queue share the arrow glyph; only Stop ⇄ arrow animates.
    const buttonMode: 'send' | 'queue' | 'stop' = !streaming
      ? 'send'
      : canSend && supportsQueue
        ? 'queue'
        : onStop
          ? 'stop'
          : 'send';
    const buttonLabel =
      buttonMode === 'stop' ? 'Stop' : buttonMode === 'queue' ? 'Queue message' : sendLabel;

    const setCaretEnd = useCallback(() => {
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) el.setSelectionRange(el.value.length, el.value.length);
      });
    }, []);

    const handleKeyDown = useCallback(
      (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
        if (e.nativeEvent.isComposing) return;

        // Suggestions. With no highlight, ArrowUp falls through to history.
        if (suggestionsOpen && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveSuggestion((prev) =>
              prev == null ? 0 : Math.min(prev + 1, suggestionsArr.length - 1),
            );
            return;
          }
          if (activeSuggestion != null) {
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActiveSuggestion(activeSuggestion === 0 ? null : activeSuggestion - 1);
              return;
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              acceptSuggestion(suggestionsArr[activeSuggestion] as string);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setActiveSuggestion(null);
              return;
            }
          }
        }

        // Tab fills the placeholder suggestion only while the draft is empty.
        if (e.key === 'Tab' && !e.shiftKey && placeholderSuggestion && value === '') {
          e.preventDefault();
          acceptSuggestion(placeholderSuggestion);
          return;
        }

        // History: only with the caret on the first / last line.
        if (
          history.length > 0 &&
          (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
          !e.shiftKey &&
          !e.altKey &&
          !e.metaKey &&
          !e.ctrlKey
        ) {
          const el = e.currentTarget;
          const caret = el.selectionStart ?? 0;
          const end = el.selectionEnd ?? caret;
          if (e.key === 'ArrowUp' && !value.slice(0, caret).includes('\n')) {
            const start = historyIndex == null ? history.length : historyIndex;
            if (start > 0) {
              e.preventDefault();
              if (historyIndex == null) draftBeforeHistory.current = value;
              const ni = start - 1;
              setHistoryIndex(ni);
              onValueChange(history[ni] as string);
              setCaretEnd();
            }
            return;
          }
          if (e.key === 'ArrowDown' && historyIndex != null && !value.slice(end).includes('\n')) {
            e.preventDefault();
            const ni = historyIndex + 1;
            if (ni >= history.length) {
              setHistoryIndex(null);
              onValueChange(draftBeforeHistory.current);
            } else {
              setHistoryIndex(ni);
              onValueChange(history[ni] as string);
            }
            setCaretEnd();
            return;
          }
        }

        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          handleSend();
        }
      },
      [
        history,
        value,
        historyIndex,
        onValueChange,
        setCaretEnd,
        handleSend,
        suggestionsOpen,
        suggestionsArr,
        activeSuggestion,
        setActiveSuggestion,
        acceptSuggestion,
        placeholderSuggestion,
      ],
    );

    const handleContainerMouseDown = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (!clickToFocus || disabled) return;
        const target = e.target as HTMLElement;
        // Slot popups keep their own focus; React events still bubble across portals.
        if (!e.currentTarget.contains(target)) return;
        if (target === textareaRef.current) return;
        if (
          target.closest(
            'button, a, input, select, textarea, [contenteditable], [role="button"], [data-im-queue]',
          )
        ) {
          return;
        }
        e.preventDefault();
        textareaRef.current?.focus();
      },
      [clickToFocus, disabled],
    );

    // ─── File helpers ────────────────────────────────────────────────────────
    const acceptTokens = useMemo(
      () =>
        accept
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      [accept],
    );

    const matchesAccept = useCallback(
      (file: File) =>
        acceptTokens.some((token) => {
          if (token.endsWith('/*')) return file.type.startsWith(token.slice(0, -1));
          if (token.startsWith('.')) return file.name.toLowerCase().endsWith(token.toLowerCase());
          return file.type === token;
        }),
      [acceptTokens],
    );

    const addFiles = useCallback(
      (incoming: File[]) => {
        if (!onFilesChange) return;
        const fingerprint = (f: File) => `${f.name}-${f.size}-${f.lastModified}`;
        const existing = new Set(filesArr.map(fingerprint));
        const accepted: File[] = [];
        for (const f of incoming) {
          if (!matchesAccept(f)) continue;
          const fp = fingerprint(f);
          if (existing.has(fp)) continue;
          existing.add(fp);
          accepted.push(f);
        }
        if (!accepted.length) return;
        const next = [...filesArr, ...accepted];
        onFilesChange(maxFiles != null ? next.slice(0, maxFiles) : next);
      },
      [onFilesChange, filesArr, matchesAccept, maxFiles],
    );

    const removeFile = useCallback(
      (idx: number) => {
        if (!onFilesChange) return;
        onFilesChange(filesArr.filter((_, i) => i !== idx));
      },
      [onFilesChange, filesArr],
    );

    const openFilePicker = useCallback(
      (overrideAccept?: string) => {
        const el = fileInputRef.current;
        if (!el) return;
        if (overrideAccept) {
          el.accept = overrideAccept;
          el.click();
          // The picker reads `accept` synchronously, so restore right after.
          queueMicrotask(() => {
            if (fileInputRef.current) fileInputRef.current.accept = accept;
          });
          return;
        }
        el.click();
      },
      [accept],
    );

    // ─── Slot rendering ──────────────────────────────────────────────────────
    const slotCtx = useMemo<InputMessageSlotContext>(
      () => ({ openFilePicker, files: filesArr }),
      [openFilePicker, filesArr],
    );
    const leftContent = <InputMessageSlotContent slot={leftSlot} ctx={slotCtx} />;
    const rightContent = <InputMessageSlotContent slot={rightSlot} ctx={slotCtx} />;

    // ─── Drag-and-drop ───────────────────────────────────────────────────────
    const handleDragOver = useCallback(
      (e: ReactDragEvent<HTMLDivElement>) => {
        if (!supportsFiles || disabled) return;
        // File drags only.
        if (!Array.from(e.dataTransfer.types).includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragOver(true);
      },
      [supportsFiles, disabled],
    );

    const handleDragLeave = useCallback((e: ReactDragEvent<HTMLDivElement>) => {
      const wrapper = e.currentTarget;
      const next = e.relatedTarget as Node | null;
      if (next && wrapper.contains(next)) return;
      setDragOver(false);
    }, []);

    const handleDrop = useCallback(
      (e: ReactDragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setDragOver(false);
        if (!supportsFiles || disabled) return;
        addFiles(Array.from(e.dataTransfer.files));
      },
      [supportsFiles, disabled, addFiles],
    );

    const handleFileInputChange = useCallback(
      (e: ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files) return;
        addFiles(Array.from(e.target.files));
        e.target.value = ''; // Allow re-selecting the same file.
      },
      [addFiles],
    );

    const inputProps: InputMessageInputProps = {
      ref: textareaRef,
      value,
      onChange: (e) => {
        setHistoryIndex(null);
        setActiveSuggestion(null);
        onValueChange(e.target.value);
      },
      onKeyDown: handleKeyDown,
      onFocus: (e) => {
        if (e.target.matches(':focus-visible')) setFocusVisible(true);
        textareaProps?.onFocus?.(e);
      },
      onBlur: (e) => {
        setFocusVisible(false);
        setActiveSuggestion(null);
        textareaProps?.onBlur?.(e);
      },
      placeholder:
        dragOver && supportsFiles
          ? 'Drop files here to add to chat'
          : placeholderSuggestion
            ? undefined
            : placeholder,
      disabled,
      rows: minRows,
      'aria-label': textareaProps?.['aria-label'] ?? 'Message',
      'aria-describedby':
        [showGhost ? ghostHintId : null, textareaDescribedBy].filter(Boolean).join(' ') ||
        undefined,
      'aria-activedescendant':
        activeSuggestion != null ? `${suggestionListId}-${activeSuggestion}` : undefined,
      className: cn(
        'w-full resize-none rounded-none bg-transparent outline-none',
        'text-foreground placeholder:text-muted-foreground',
        compactStep
          ? 'text-[length:var(--fs-subtitle-compact,13px)] leading-[var(--lh-subtitle-compact,18px)] px-1.5 py-1.5'
          : 'text-[length:var(--fs-subtitle,14px)] leading-[var(--lh-subtitle,20px)] px-2 py-2',
        fieldTouchClass,
        textareaClassName,
      ),
      style: { fontVariationSettings: fontWeights.normal },
      ...restTextareaProps,
    };

    const action = (
      <Button
        type="button"
        variant="primary"
        size="icon-sm"
        onClick={buttonMode === 'stop' ? handleStop : handleSend}
        disabled={buttonMode === 'stop' ? disabled : !canSend}
        aria-label={buttonLabel}
        aria-description={sendDescription}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={buttonMode === 'stop' ? 'stop' : 'arrow'}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={
              reduceMotion
                ? { opacity: 0 }
                : { opacity: 0, scale: 0.6, transition: spring.fast.exit }
            }
            transition={spring.fast}
            className="flex items-center justify-center leading-none"
          >
            {buttonMode === 'stop' ? (
              <span className="h-3 w-3 rounded-[3px] bg-current" />
            ) : (
              // Larger than icon-sm's 14px; `size` matches the CSS so
              // the svg stays centered.
              <ArrowUpIcon
                size={compactStep ? 15 : 19}
                className={cn('block', compactStep ? '!h-[15px] !w-[15px]' : '!h-[19px] !w-[19px]')}
              />
            )}
          </motion.span>
        </AnimatePresence>
      </Button>
    );

    const composer = (
      // biome-ignore lint/a11y/noStaticElementInteractions: pointer gaps focus the existing textarea; file drops supplement the file picker.
      <div
        ref={ref}
        onMouseDown={handleContainerMouseDown}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'flex flex-col gap-1 p-2 transition-[box-shadow,color] duration-80',
          surfaceClasses(2, 2),
          shape.container,
          clickToFocus && !disabled && 'cursor-text',
          disabled && 'opacity-50 pointer-events-none',
          className,
        )}
        style={edgeShadow ? { boxShadow: edgeShadow, ...style } : style}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        {...props}
      >
        <SurfaceProvider value={2}>
          {contentSlot}
          {supportsFiles && (
            <input
              ref={fileInputRef}
              type="file"
              accept={accept}
              multiple={maxFiles == null || maxFiles > 1}
              className="hidden"
              onChange={handleFileInputChange}
              aria-hidden="true"
              tabIndex={-1}
            />
          )}

          {/* Attached files. popLayout lets siblings slide into a removed
              tile's gap; keys are file identity (no index) so removing one
              doesn't remount the rest. */}
          <AnimatePresence initial={false}>
            {filesArr.length > 0 && (
              <motion.div
                key="preview-row"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: filesRegionHeight ?? 0, opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ ...spring.moderate, bounce: 0 }}
                className="overflow-hidden"
              >
                <div ref={filesRegionRef} className="flex flex-wrap gap-2 pb-1">
                  <AnimatePresence initial={false} mode="popLayout">
                    {filesArr.map((file, i) => (
                      <FilePreviewTile
                        key={`${file.name}-${file.size}-${file.lastModified}`}
                        file={file}
                        onRemove={() => removeFile(i)}
                        size={filePreviewSize}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Queued messages */}
          {supportsQueue && showQueue && (
            <AnimatePresence initial={false}>
              {queueArr.length > 0 && (
                <motion.div
                  key="queue-row"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: queueRegionHeight ?? 0, opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ ...spring.moderate, bounce: 0 }}
                  className="overflow-hidden"
                >
                  <Reorder.Group
                    ref={queueRegionRef}
                    axis="y"
                    values={queueArr}
                    onReorder={(next) => onQueueChange?.(next)}
                    data-im-queue
                    className="flex flex-col gap-1 pb-1"
                  >
                    <AnimatePresence initial={false}>
                      {queueArr.map((item, i) => (
                        <QueuedRow
                          key={item.id}
                          item={item}
                          index={i}
                          total={queueArr.length}
                          reduceMotion={reduceMotion}
                          isTouch={isTouch}
                          onEdit={editQueued}
                          onRemove={removeQueued}
                          onMove={moveQueued}
                        />
                      ))}
                    </AnimatePresence>
                  </Reorder.Group>
                </motion.div>
              )}
            </AnimatePresence>
          )}

          <div className="relative">
            {renderInput ? renderInput(inputProps) : <textarea {...inputProps} />}
            {/* Ghost placeholder: an overlay so the Tab keycap can sit inline. */}
            {showGhost && (
              <div
                aria-hidden="true"
                className={cn(
                  'pointer-events-none absolute inset-0 overflow-hidden text-muted-foreground',
                  // Must mirror the textarea's typography exactly.
                  compactStep
                    ? 'text-[length:var(--fs-subtitle-compact,13px)] leading-[var(--lh-subtitle-compact,18px)] px-1.5 py-1.5'
                    : 'text-[length:var(--fs-subtitle,14px)] leading-[var(--lh-subtitle,20px)] px-2 py-2',
                  fieldTouchClass,
                )}
                style={{ fontVariationSettings: fontWeights.normal }}
              >
                {/* One line: long text truncates and the Tab chip never gets cut. */}
                <span className="flex max-w-full items-center gap-1.5">
                  <span className="min-w-0 truncate">{placeholderSuggestion}</span>
                  <kbd
                    className={cn(
                      'inline-flex shrink-0 -translate-y-px items-center border border-border bg-background px-1 font-sans text-muted-foreground',
                      compactStep
                        ? 'h-4 text-[length:var(--fs-micro-compact,10px)] leading-[var(--lh-micro-compact,12px)]'
                        : 'h-[18px] text-[length:var(--fs-micro,11px)] leading-[var(--lh-micro,14px)]',
                      shape.chip,
                    )}
                  >
                    Tab
                  </kbd>
                </span>
              </div>
            )}
            {showGhost && (
              <span id={ghostHintId} className="sr-only">
                Suggested prompt: {placeholderSuggestion}. Press Tab to fill the composer with it.
              </span>
            )}
          </div>
          <div
            className={cn(
              'flex flex-wrap items-center justify-between',
              // Compact scales every button in the row (slots are
              // consumer-authored) down to 24px. The model chip keeps 24px as its least
              // height: a name it cannot fit takes another line instead of being cut.
              compactStep
                ? 'gap-1.5 [&_button:not([data-slot=model-picker-trigger])]:h-6 [&_[data-slot=model-picker-trigger]]:min-h-6 [&_button.w-7]:w-6 [&_button]:text-[length:var(--fs-caption-compact,11px)] [&_button]:leading-[var(--lh-caption-compact,14px)]'
                : 'gap-2',
            )}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">{leftContent}</div>
            <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1.5">
              {rightContent}
              {renderAction ? renderAction(action) : action}
            </div>
          </div>

          {/* Suggested prompts. -mx-2 lets the divider run full width. */}
          {suggestionsArr.length > 0 && (
            <AnimatePresence initial={false}>
              {suggestionsOpen && (
                <motion.div
                  key="suggestions"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: suggestionsRegionHeight ?? 0, opacity: 1 }}
                  // Height-only exit: a fade would hide the divider mid-collapse.
                  exit={{ height: 0 }}
                  transition={{ ...spring.moderate, bounce: 0 }}
                  // -mt-1 + the listbox's mt-2 move the container gap inside
                  // the animated height, so it doesn't snap away at unmount.
                  className="-mx-2 -mt-1 overflow-hidden"
                >
                  {/* biome-ignore lint/a11y/useKeyWithClickEvents: shared gap clicks supplement the input keyboard handler. */}
                  <div
                    ref={(el) => {
                      suggestionListRef.current = el;
                      suggestionsRegionRef(el);
                    }}
                    role="listbox"
                    id={suggestionListId}
                    aria-label="Suggested prompts"
                    onMouseEnter={suggestionHandlers.onMouseEnter}
                    onMouseMove={suggestionHandlers.onMouseMove}
                    onMouseLeave={suggestionHandlers.onMouseLeave}
                    onClick={suggestionHandlers.onClick}
                    className="relative mt-2 flex flex-col border-t border-border/60 px-1.5 pt-1.5"
                  >
                    <FluidHoverHighlight hover={suggestionHover} className={shape.bg} />
                    {suggestionsArr.map((s, i) => (
                      <SuggestionRow
                        // biome-ignore lint/suspicious/noArrayIndexKey: suggestions may repeat and have stable source order.
                        key={`${s}-${i}`}
                        text={s}
                        index={i}
                        active={i === activeSuggestion}
                        keyHint={i === 0 && activeSuggestion == null}
                        optionId={`${suggestionListId}-${i}`}
                        registerItem={registerSuggestion}
                        onSelect={() => acceptSuggestion(s)}
                      />
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          )}
          <span className="sr-only" role="status" aria-live="polite">
            {liveMsg}
          </span>
        </SurfaceProvider>
      </div>
    );

    return size ? <SizeProvider size={size}>{composer}</SizeProvider> : composer;
  },
);

InputMessage.displayName = 'InputMessage';

export type { InputMessageInputProps, InputMessageProps, InputMessageSlotContext, QueuedMessage };
export { InputMessage };
export default InputMessage;
