'use client';

import { AnimatePresence, motion, useAnimationControls } from 'motion/react';
import {
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { focusRing } from '../../lib/focus.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { useIcons } from '../../lib/icon-context.tsx';
import { nestedRadius, useShape } from '../../lib/shape-context.tsx';
import { typeClass, useSizeVariant } from '../../lib/size-context.tsx';
import { spring, tween } from '../../lib/springs.ts';
import { FileThumbnail } from '../ui/file-thumbnail.tsx';
import type { QueuedMessage } from '../ui/input-message.tsx';
import { Tooltip } from '../ui/tooltip.tsx';

// -----------------------------------------------------------------------------
// Messages queued above an InputMessage. Hover (tap on touch) fans the cards
// out. While fanned, drag reorders them (only with `onQueueChange`), × removes
// one, and the pencil or a double-click sends that card back into the composer.
// -----------------------------------------------------------------------------

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export const QUEUE_CARD_H = 44;
export const QUEUE_CARD_H_COMPACT = 38;
const STACK_PEEK = 12;
const STACK_SCALE = 0.05;
const STACK_GAP = 8;
const STACK_MAX_PEEK = 2;

/** The stack's card height at the current size step. */
export function useQueueCardHeight() {
  return useSizeVariant() === 'compact' ? QUEUE_CARD_H_COMPACT : QUEUE_CARD_H;
}

/** Height of the collapsed pile — consumers reserve transcript padding with it. */
export function collapsedStackHeight(count: number, cardH: number) {
  return cardH + Math.min(Math.max(count - 1, 0), STACK_MAX_PEEK) * STACK_PEEK;
}

interface QueuedStackLabels {
  /** Tooltip of the touch collapse button. */
  collapse: string;
  /** Accessible name of the touch collapse button. */
  collapseQueue: string;
  /** Tooltip on the gutter arrow. */
  queued: (count: number) => string;
  /** Card text for a message with attachments only. */
  attachments: (count: number) => string;
  /** Tooltip of the edit button. */
  edit: string;
  /** Accessible name of a card's edit button. */
  editMessage: (text: string) => string;
  /** Tooltip of the remove button. */
  remove: string;
  /** Accessible name of a card's remove button. */
  removeMessage: (text: string) => string;
}

const defaultLabels: QueuedStackLabels = {
  collapse: 'Collapse',
  collapseQueue: 'Collapse queued messages',
  queued: (n) => `${n} queued message${n === 1 ? '' : 's'}`,
  attachments: (n) => `${n} attachment${n === 1 ? '' : 's'}`,
  edit: 'Edit',
  editMessage: (text) => `Edit queued message: ${text}`,
  remove: 'Remove',
  removeMessage: (text) => `Remove queued message: ${text}`,
};

/** Keeps a press on a card's controls from dragging, expanding or editing the card. */
const stopCardGesture = (e: SyntheticEvent) => e.stopPropagation();

interface QueuedStackProps {
  queue: QueuedMessage[];
  /** Fired with the reordered queue while dragging a card between slots. Omit
   *  when the order can't change: the cards then don't drag. */
  onQueueChange?: (queue: QueuedMessage[]) => void;
  /** Pull a card back into the composer (✎ button / double-click). */
  onEdit: (item: QueuedMessage) => void;
  /** Remove a card (× button). */
  onRemove: (item: QueuedMessage) => void;
  /** Distance from the container's bottom edge (usually composer height + 8). */
  bottom: number;
  /** Shared-layout id so a dispatched card can morph into its sent bubble.
   *  Applied to text-only cards while no drag is in progress. */
  morphLayoutId?: (item: QueuedMessage) => string;
  /** Extra controls for a card (e.g. the host's "Start now"), shown before
   *  edit and remove. A press on them never drags, expands or edits the card. */
  renderActions?: (item: QueuedMessage) => ReactNode;
  /** Localized tooltips, names and counts; the source English is the default. */
  labels?: Partial<QueuedStackLabels>;
}

export function QueuedStack({
  queue,
  onQueueChange,
  onEdit,
  onRemove,
  bottom,
  morphLayoutId,
  renderActions,
  labels: labelOverrides,
}: QueuedStackProps) {
  const labels = { ...defaultLabels, ...labelOverrides };
  const reorderable = onQueueChange !== undefined;
  const shape = useShape();
  const compactStep = useSizeVariant() === 'compact';
  const cardH = useQueueCardHeight();
  // Previews inset 8px (compact ~7px), so their radius nests concentrically.
  const attachmentRadius = nestedRadius(shape.bgRadius, compactStep ? 7 : 8);
  const icons = useIcons();
  const XIcon = icons.x;
  const PencilIcon = icons.pencil;
  const ChevronDownIcon = icons['chevron-down'];
  const CornerDownRightIcon = icons['corner-down-right'];

  // ─── Stack geometry ────────────────────────────────────────────────────────
  const stackCount = queue.length;
  const collapsedStackH = collapsedStackHeight(stackCount, cardH);
  const expandedStackH = stackCount * cardH + Math.max(stackCount - 1, 0) * STACK_GAP;
  // Cards beyond the visible peeks; shown as a count on the gutter arrow.
  const hiddenCount = Math.max(0, stackCount - (STACK_MAX_PEEK + 1));

  // ─── Drag-to-reorder (expanded only). Window listeners so release works anywhere.
  const stackRef = useRef<HTMLDivElement>(null);
  const [stackHovered, setStackHovered] = useState(false);
  const [pointerDownId, setPointerDownId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragY, setDragY] = useState(0);
  const dragStartYRef = useRef(0);
  const queueRef = useRef(queue);
  useIsoLayoutEffect(() => {
    queueRef.current = queue;
  });

  // Without hover, a tap expands the stack and pins it open until collapsed.
  const [isTouch, setIsTouch] = useState(false);
  const [tapExpanded, setTapExpanded] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(hover: none)');
    const update = () => setIsTouch(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  // An emptied stack unpins, so the next fill starts collapsed.
  if (queue.length === 0 && tapExpanded) setTapExpanded(false);

  const stackExpanded =
    stackHovered || pointerDownId !== null || draggingId !== null || tapExpanded;
  const slotY = (i: number) => -i * (cardH + STACK_GAP);

  // ─── Enqueue feedback: past the peek cap a new card is invisible, so recoil
  // the stack on growth. Skipped while expanded and on the first fill.
  const stackBump = useAnimationControls();
  const prevStackCountRef = useRef(stackCount);
  useEffect(() => {
    const prev = prevStackCountRef.current;
    prevStackCountRef.current = stackCount;
    if (stackCount > prev && prev > 0 && !stackExpanded) {
      stackBump.set({ y: -7 });
      stackBump.start({
        y: 0,
        transition: { type: 'spring', duration: 0.42, bounce: 0.5 },
      });
    }
    // Acts only when the count grew; the other deps re-run it as a no-op.
  }, [stackCount, stackExpanded, stackBump]);

  useEffect(() => {
    if (!pointerDownId || !onQueueChange) return;
    let started = false;
    const onMove = (e: PointerEvent) => {
      const el = stackRef.current;
      if (!el) return;
      if (!started) {
        if (Math.abs(e.clientY - dragStartYRef.current) < 4) return;
        started = true;
        setDraggingId(pointerDownId);
      }
      const rect = el.getBoundingClientRect();
      const fromBottom = rect.bottom - e.clientY;
      const q = queueRef.current;
      const slot = Math.max(
        0,
        Math.min(q.length - 1, Math.floor(fromBottom / (cardH + STACK_GAP))),
      );
      const cur = q.findIndex((x) => x.id === pointerDownId);
      if (cur !== -1 && cur !== slot) {
        const moved = q[cur] as QueuedMessage;
        const next = [...q];
        next.splice(cur, 1);
        next.splice(slot, 0, moved);
        onQueueChange(next);
      }
      const minY = -(queueRef.current.length - 1) * (cardH + STACK_GAP);
      setDragY(Math.max(minY, Math.min(0, e.clientY - rect.bottom + cardH / 2)));
    };
    const onUp = () => {
      setPointerDownId(null);
      setDraggingId(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [pointerDownId, cardH, onQueueChange]);

  return (
    <AnimatePresence>
      {stackCount > 0 && (
        <motion.div
          ref={stackRef}
          className="absolute inset-x-0 z-10"
          style={{ bottom }}
          initial={{ opacity: 0 }}
          animate={{
            opacity: 1,
            height: stackExpanded ? expandedStackH : collapsedStackH,
          }}
          exit={{ opacity: 0 }}
          transition={{ ...spring.moderate, bounce: 0 }}
          onMouseEnter={() => setStackHovered(true)}
          onMouseLeave={() => setStackHovered(false)}
        >
          {/* Recoils on enqueue (see stackBump). */}
          <motion.div animate={stackBump} className="absolute inset-0">
            {isTouch && stackExpanded ? (
              // Touch: a pinned-open stack needs an explicit collapse button.
              <Tooltip content={labels.collapse} side="left">
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    setTapExpanded(false);
                  }}
                  aria-label={labels.collapseQueue}
                  className={`absolute bottom-0 left-0 flex items-center justify-center text-muted-foreground hover:text-foreground ${focusRing} ${shape.button}`}
                  style={{ height: cardH, width: 40 }}
                >
                  <ChevronDownIcon size={18} strokeWidth={2} />
                </button>
              </Tooltip>
            ) : (
              <Tooltip content={labels.queued(stackCount)} side="left">
                <div
                  className="absolute bottom-0 left-0 flex items-center justify-end gap-1 pr-1 text-muted-foreground"
                  style={{ height: cardH, width: 40 }}
                >
                  {/* Total count once the stack overflows; justify-end keeps
                      the arrow from moving as it appears. */}
                  <AnimatePresence>
                    {hiddenCount > 0 && (
                      <motion.span
                        key="count"
                        initial={{ opacity: 0, scale: 0.6 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.6 }}
                        transition={spring.fast}
                        className="pointer-events-none text-[length:var(--fs-micro-compact,10px)] leading-none tabular-nums text-muted-foreground"
                        style={{ fontVariationSettings: fontWeights.semibold }}
                      >
                        {stackCount}
                      </motion.span>
                    )}
                  </AnimatePresence>
                  <CornerDownRightIcon size={16} strokeWidth={2} />
                </div>
              </Tooltip>
            )}
            <AnimatePresence initial={false}>
              {queue.map((item, i) => {
                const peek = Math.min(i, STACK_MAX_PEEK);
                const isDragging = draggingId === item.id;
                const target = stackExpanded
                  ? {
                      y: isDragging ? dragY : slotY(i),
                      scale: isDragging ? 1.03 : 1,
                      opacity: 1,
                    }
                  : {
                      y: -peek * STACK_PEEK,
                      scale: 1 - peek * STACK_SCALE,
                      opacity: i <= STACK_MAX_PEEK ? 1 : 0,
                    };
                return (
                  <motion.div
                    key={item.id}
                    // Morph into the sent bubble for text-only cards (attachment
                    // layouts differ too much). Dropped during any drag: layout
                    // projection fights the animated `y` and cards won't settle.
                    layoutId={
                      morphLayoutId && pointerDownId === null && item.files.length === 0
                        ? morphLayoutId(item)
                        : undefined
                    }
                    onDoubleClick={() => onEdit(item)}
                    onClick={() => {
                      // Touch tap-to-expand; no-op once expanded.
                      if (isTouch && !stackExpanded) setTapExpanded(true);
                    }}
                    onPointerDown={(e) => {
                      if (!reorderable || !stackExpanded || e.button !== 0) return;
                      dragStartYRef.current = e.clientY;
                      setDragY(slotY(i));
                      setPointerDownId(item.id);
                    }}
                    initial={{ opacity: 0, y: 14, scale: 0.96 }}
                    animate={target}
                    exit={{
                      opacity: 0,
                      scale: 0.9,
                      transition: tween.moderate.exit,
                    }}
                    transition={isDragging ? { duration: 0 } : spring.moderate}
                    style={{
                      height: cardH,
                      transformOrigin: 'bottom center',
                      zIndex: isDragging ? 200 : 100 - i,
                      cursor: stackExpanded && reorderable ? 'grab' : 'default',
                      // Touch-drag reorders instead of scrolling the page.
                      touchAction: stackExpanded && reorderable ? 'none' : undefined,
                    }}
                    // Equal side gutters center the cards; with attachments the
                    // left padding matches the thumbnail's vertical inset.
                    className={`group/qm absolute bottom-0 left-10 right-10 flex select-none items-center bg-[color-mix(in_oklab,var(--accent),var(--background)_68%)] ${
                      compactStep
                        ? `gap-1.5 ${item.files.length > 0 ? 'pl-1.5' : 'pl-3'} pr-1`
                        : `gap-2 ${item.files.length > 0 ? 'pl-2' : 'pl-3.5'} pr-1.5`
                    } ${typeClass('subtitle', compactStep ? 'compact' : 'default')} text-muted-foreground shadow-surface-3 ${reorderable ? 'active:cursor-grabbing' : ''} ${shape.bg}`}
                  >
                    {item.files.length > 0 && (
                      <div className="pointer-events-none flex shrink-0 items-center gap-1">
                        {item.files.slice(0, 3).map((f, fi) => (
                          <FileThumbnail
                            // biome-ignore lint/suspicious/noArrayIndexKey: attachments may share a name and size and never reorder.
                            key={`${f.name}-${f.size}-${fi}`}
                            file={f}
                            size={compactStep ? 24 : 28}
                            radius={attachmentRadius}
                          />
                        ))}
                        {item.files.length > 3 && (
                          <span
                            className={`flex ${compactStep ? 'h-6 w-6' : 'h-7 w-7'} items-center justify-center bg-background/40 text-[length:var(--fs-micro,11px)] leading-[var(--lh-micro,14px)] tabular-nums text-foreground`}
                            style={{ borderRadius: attachmentRadius }}
                          >
                            +{item.files.length - 3}
                          </span>
                        )}
                      </div>
                    )}
                    <span className="pointer-events-none min-w-0 flex-1 truncate">
                      {item.text || labels.attachments(item.files.length)}
                    </span>
                    {/* Edit and remove: shown on hover (always on touch), out
                        of layout otherwise so the text gets the full width. */}
                    <div
                      className={`shrink-0 items-center gap-1 ${
                        isTouch ? 'flex' : 'hidden group-hover/qm:flex'
                      }`}
                    >
                      {renderActions && (
                        // biome-ignore lint/a11y/noStaticElementInteractions: it only stops the card's drag, tap and double-click gestures; the host's controls own activation.
                        // biome-ignore lint/a11y/useKeyWithClickEvents: no action of its own; keyboard input reaches the host's controls.
                        <span
                          className="contents"
                          onPointerDown={stopCardGesture}
                          onClick={stopCardGesture}
                          onDoubleClick={stopCardGesture}
                        >
                          {renderActions(item)}
                        </span>
                      )}
                      <Tooltip content={labels.edit} side="top">
                        <button
                          type="button"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            onEdit(item);
                          }}
                          aria-label={labels.editMessage(item.text)}
                          className={`flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center ${shape.button} text-muted-foreground hover:bg-hover hover:text-foreground ${focusRing}`}
                        >
                          <PencilIcon size={14} strokeWidth={2} />
                        </button>
                      </Tooltip>
                      <Tooltip content={labels.remove} side="top">
                        <button
                          type="button"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemove(item);
                          }}
                          aria-label={labels.removeMessage(item.text)}
                          className={`flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center ${shape.button} text-muted-foreground hover:bg-hover hover:text-foreground ${focusRing}`}
                        >
                          <XIcon size={14} strokeWidth={2.5} />
                        </button>
                      </Tooltip>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export type { QueuedStackLabels, QueuedStackProps };
