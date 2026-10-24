'use client';

import { Collapsible } from '@base-ui/react/collapsible';
import { AnimatePresence, motion } from 'motion/react';
import {
  createContext,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

// SSR-safe layout effect (client components still server-render in Next).
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

import { fontWeights } from '../../lib/font-weight.ts';
import type { IconName } from '../../lib/icon-context.tsx';
import { useIcons } from '../../lib/icon-context.tsx';
import { omit } from '../../lib/omit.ts';
import { useShape } from '../../lib/shape-context.tsx';
import { SizeProvider, type SizeVariant, typeClass, useSize } from '../../lib/size-context.tsx';
import { spring } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';
import type { BadgeColor } from './badge.tsx';
import { Badge } from './badge.tsx';

// ─── Shared collapsible parts ───────────────────────────────────────────────

/** Open state of the nearest ThinkingSteps root, for the header trigger/panel. */
const ThinkingStepsOpenContext = createContext(false);

interface TriggerRowProps extends HTMLAttributes<HTMLButtonElement> {
  open: boolean;
  children: ReactNode;
}

/** Trigger row: hover background, weight-animated label, rotating chevron. */
const TriggerRow = forwardRef<HTMLButtonElement, TriggerRowProps>(
  ({ open, children, className, ...props }, ref) => {
    const icons = useIcons();
    const ChevronRight = icons['chevron-right'];
    const shape = useShape();
    const sizeClasses = useSize();
    const [isHovered, setIsHovered] = useState(false);
    const highlighted = open || isHovered;

    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: Hover only paints the decorative highlight; the Collapsible trigger owns semantics and keyboard interaction.
      <div
        className="relative w-fit"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <AnimatePresence>
          {isHovered && (
            <motion.div
              className={`absolute inset-0 ${shape.bg} bg-hover pointer-events-none`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: spring.fast.exit }}
              transition={{ duration: 0.08 }}
            />
          )}
        </AnimatePresence>
        <Collapsible.Trigger
          ref={ref}
          className={cn(
            `relative z-10 flex items-center gap-2.5 ${shape.item} ${sizeClasses.px} ${
              sizeClasses.variant === 'compact' ? 'py-1.5' : 'py-2'
            } cursor-pointer outline-none select-none`,
            'focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)] focus-visible:ring-offset-0',
            className,
          )}
          {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}
        >
          {/* Label with dual-layer text (invisible bold layer reserves width) */}
          <span className={cn('inline-grid text-left', sizeClasses.text)}>
            <span
              className="col-start-1 row-start-1 invisible"
              style={{ fontVariationSettings: fontWeights.semibold }}
              aria-hidden="true"
            >
              {children}
            </span>
            <span
              className={cn(
                'col-start-1 row-start-1 transition-[color,font-variation-settings] duration-80',
                highlighted ? 'text-foreground' : 'text-muted-foreground',
              )}
              style={{
                fontVariationSettings: open ? fontWeights.semibold : fontWeights.normal,
              }}
            >
              {children}
            </span>
          </span>

          <motion.span
            className="shrink-0 inline-flex items-center justify-center"
            animate={{ rotate: open ? 90 : 0 }}
            transition={spring.fast}
          >
            <ChevronRight
              size={sizeClasses.icon}
              strokeWidth={highlighted ? 2 : 1.5}
              className={cn(
                'transition-[color,stroke-width] duration-80',
                highlighted ? 'text-foreground' : 'text-muted-foreground',
              )}
            />
          </motion.span>
        </Collapsible.Trigger>
      </div>
    );
  },
);
TriggerRow.displayName = 'ThinkingStepsTriggerRow';

interface CollapsePanelProps {
  open: boolean;
  children: ReactNode;
}

/**
 * Collapsible panel with a spring height animation. Base UI sets `hidden` as
 * soon as it closes, cutting the JS exit short, so we strip it and apply it
 * after the exit. The panel stays mounted to keep `aria-controls` valid.
 */
function CollapsePanel({ open, children }: CollapsePanelProps) {
  const compactStep = useSize().variant === 'compact';
  // Animate to a measured offsetHeight, not "auto": framer resolves "auto"
  // from the transformed size and overshoots under a scaled ancestor.
  const innerRef = useRef<HTMLDivElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  // Panels open at mount start at "auto"; the hand-off to the first measured
  // height must snap, not spring.
  const [needsSnap, setNeedsSnap] = useState(open);

  const measureRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    innerRef.current = el;
    if (!el) return;
    if (el.offsetHeight > 0) setContentHeight(el.offsetHeight);
    const ro = new ResizeObserver(() => {
      // Ignore the 0 that fires while the panel is display:none.
      if (el.offsetHeight > 0) setContentHeight(el.offsetHeight);
    });
    ro.observe(el);
    roRef.current = ro;
  }, []);

  // Re-measure before paint on open so the spring targets the fresh height.
  useIsoLayoutEffect(() => {
    if (open && innerRef.current && innerRef.current.offsetHeight > 0) {
      setContentHeight(innerRef.current.offsetHeight);
    }
  }, [open]);

  // Cleared a frame after the first measured height commits.
  useEffect(() => {
    if (!needsSnap || contentHeight === null) return;
    const frame = requestAnimationFrame(() => setNeedsSnap(false));
    return () => cancelAnimationFrame(frame);
  }, [needsSnap, contentHeight]);

  const [exitComplete, setExitComplete] = useState(!open);
  if (open && exitComplete) {
    // Reset during render so the panel is un-hidden before the first paint.
    setExitComplete(false);
  }

  return (
    <Collapsible.Panel
      keepMounted
      render={(panelProps) => {
        const restPanel = omit(panelProps as React.HTMLAttributes<HTMLDivElement>, [
          // Applied too early for the exit animation; set manually below.
          'hidden',
          // Only the panel size vars, which stay 'auto' here.
          'style',
        ]);
        return (
          <div {...restPanel} hidden={!open && exitComplete}>
            <motion.div
              className="overflow-hidden"
              initial={{ height: open ? 'auto' : 0 }}
              animate={{ height: open ? (contentHeight ?? 0) : 0 }}
              // bounce: 0 — pure height looks better without overshoot.
              transition={needsSnap ? { duration: 0 } : { ...spring.moderate, bounce: 0 }}
              onAnimationComplete={() => {
                if (!open) setExitComplete(true);
              }}
            >
              <div
                ref={measureRef}
                className={cn(
                  'px-3 pb-3 pt-1 text-muted-foreground',
                  typeClass('body', compactStep ? 'compact' : 'default'),
                )}
              >
                {children}
              </div>
            </motion.div>
          </div>
        );
      }}
    />
  );
}

// ─── ThinkingSteps (root) ───────────────────────────────────────────────────

interface ThinkingStepsProps extends HTMLAttributes<HTMLDivElement> {
  /** Size step for every row inside; overrides the surrounding SizeProvider. */
  size?: SizeVariant;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}

const ThinkingSteps = forwardRef<HTMLDivElement, ThinkingStepsProps>(
  ({ size, defaultOpen = true, open, onOpenChange, children, className, ...props }, ref) => {
    // Always controlled so header and panel can read open state from context.
    const [internalOpen, setInternalOpen] = useState(defaultOpen);
    const isOpen = open ?? internalOpen;

    const root = (
      <Collapsible.Root
        ref={ref}
        open={isOpen}
        onOpenChange={(next: boolean) => {
          if (open === undefined) setInternalOpen(next);
          onOpenChange?.(next);
        }}
        className={cn('w-80 max-w-full', className)}
        {...props}
      >
        <ThinkingStepsOpenContext.Provider value={isOpen}>
          {children}
        </ThinkingStepsOpenContext.Provider>
      </Collapsible.Root>
    );

    return size ? <SizeProvider size={size}>{root}</SizeProvider> : root;
  },
);
ThinkingSteps.displayName = 'ThinkingSteps';

// ─── ThinkingStepsHeader ────────────────────────────────────────────────────

interface ThinkingStepsHeaderProps extends HTMLAttributes<HTMLButtonElement> {
  children?: ReactNode;
}

const ThinkingStepsHeader = forwardRef<HTMLButtonElement, ThinkingStepsHeaderProps>(
  ({ children = 'Thinking', className, ...props }, ref) => {
    const isOpen = useContext(ThinkingStepsOpenContext);
    return (
      <TriggerRow ref={ref} open={isOpen} className={className} {...props}>
        {children}
      </TriggerRow>
    );
  },
);
ThinkingStepsHeader.displayName = 'ThinkingStepsHeader';

// ─── ThinkingStepsContent ───────────────────────────────────────────────────

interface ThinkingStepsContentProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

const ThinkingStepsContent = forwardRef<HTMLDivElement, ThinkingStepsContentProps>(
  ({ children, className, ...props }, ref) => {
    const isOpen = useContext(ThinkingStepsOpenContext);
    return (
      <CollapsePanel open={isOpen}>
        <div ref={ref} className={cn('flex flex-col', className)} {...props}>
          {children}
        </div>
      </CollapsePanel>
    );
  },
);
ThinkingStepsContent.displayName = 'ThinkingStepsContent';

// ─── ThinkingStep ───────────────────────────────────────────────────────────

type StepStatus = 'complete' | 'active' | 'pending';

interface ThinkingStepProps {
  icon?: IconName;
  showIcon?: boolean;
  label: string;
  description?: string;
  status?: StepStatus;
  delay?: number;
  isLast?: boolean;
  children?: ReactNode;
  className?: string;
}

/** Measured height for a step's opening animation; avoids "auto", which
 *  overshoots under a scaled ancestor (see CollapsePanel). */
function useStepHeight() {
  const roRef = useRef<ResizeObserver | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el) return;
    const sync = () => {
      if (el.offsetHeight > 0) setHeight(el.offsetHeight);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    roRef.current = ro;
  }, []);
  return [ref, height] as const;
}

function ThinkingStep({
  icon = 'dot',
  showIcon = true,
  label,
  description,
  status = 'complete',
  delay = 0.08,
  isLast = false,
  children,
  className,
}: ThinkingStepProps) {
  const icons = useIcons();
  const Icon = icons[icon];
  const shape = useShape();
  const sizeClasses = useSize();
  const [stepRef, stepHeight] = useStepHeight();

  if (status === 'pending') return null;

  const isActive = status === 'active';

  return (
    /* Outer animates height; inner fades in and is the measured element. */
    <motion.div
      className={cn('relative z-10 overflow-hidden', className)}
      initial={{ height: 0 }}
      animate={{ height: stepHeight ?? 0 }}
      transition={spring.slow}
    >
      <motion.div
        ref={stepRef}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.24, delay, ease: 'easeOut' }}
      >
        <div className={cn('flex gap-2.5 px-2 py-1.5', shape.item)}>
          {/* Icon column with connector line */}
          <div className="flex flex-col items-center shrink-0 w-[14px]">
            <div className="pt-0.5">
              {showIcon ? (
                <Icon
                  size={sizeClasses.variant === 'compact' ? 12 : 14}
                  strokeWidth={1.5}
                  className="text-muted-foreground"
                />
              ) : (
                <div className="w-[14px] h-[14px] flex items-center justify-center">
                  <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60" />
                </div>
              )}
            </div>
            {!isLast && <div className="flex-1 w-px bg-border/60 mt-1" />}
          </div>

          <div className="flex-1 flex flex-col gap-1 min-w-0">
            <span
              className={cn(sizeClasses.type.body, 'text-foreground', isActive && 'shimmer-text')}
              style={{ fontVariationSettings: fontWeights.semibold }}
            >
              {label}
              {isActive && '…'}
            </span>
            {description && (
              <span className={cn(sizeClasses.type.body, 'text-muted-foreground')}>
                {description}
              </span>
            )}
            {children}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─── ThinkingStepDetails (nested collapsible) ───────────────────────────────

interface ThinkingStepDetailsProps {
  summary: string;
  details?: string[];
  defaultOpen?: boolean;
  /** Corral: controlled open state, so a caller can mount heavy content only once opened. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
  className?: string;
}

function ThinkingStepDetails({
  summary,
  details,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  children,
  className,
}: ThinkingStepDetailsProps) {
  const compactStep = useSize().variant === 'compact';
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const open = controlledOpen ?? internalOpen;

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={(next: boolean) => {
        if (controlledOpen === undefined) setInternalOpen(next);
        onOpenChange?.(next);
      }}
      className={cn('mt-1 -ml-3', className)}
    >
      <TriggerRow open={open} className="py-1 px-3 gap-1.5">
        {summary}
      </TriggerRow>
      <CollapsePanel open={open}>
        <div className="flex flex-col gap-0.5 pt-0.5">
          {details?.map((item, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: Detail lines are static text and may repeat.
              key={i}
              className={cn(
                'text-muted-foreground',
                typeClass('caption', compactStep ? 'compact' : 'default'),
              )}
            >
              {item}
            </span>
          ))}
          {children}
        </div>
      </CollapsePanel>
    </Collapsible.Root>
  );
}

// ─── ThinkingStepSources ────────────────────────────────────────────────────

interface ThinkingStepSourcesProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

const ThinkingStepSources = forwardRef<HTMLDivElement, ThinkingStepSourcesProps>(
  ({ children, className, ...props }, ref) => {
    return (
      <div ref={ref} className={cn('flex flex-wrap gap-1.5 mt-1', className)} {...props}>
        {children}
      </div>
    );
  },
);
ThinkingStepSources.displayName = 'ThinkingStepSources';

// ─── ThinkingStepSource ─────────────────────────────────────────────────────

interface ThinkingStepSourceProps {
  color?: BadgeColor;
  delay?: number;
  children: ReactNode;
  className?: string;
}

function ThinkingStepSource({
  color = 'gray',
  delay = 0,
  children,
  className,
}: ThinkingStepSourceProps) {
  return (
    <motion.span
      initial={{ opacity: 0, scale: 0.85, filter: 'blur(4px)' }}
      animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
      transition={{
        ...spring.moderate,
        delay,
        filter: { duration: 0.12, delay },
      }}
    >
      <Badge variant="solid" size="sm" color={color} className={className}>
        {children}
      </Badge>
    </motion.span>
  );
}
ThinkingStepSource.displayName = 'ThinkingStepSource';

// ─── ThinkingStepImage ──────────────────────────────────────────────────────

interface ThinkingStepImageProps {
  src: string;
  alt?: string;
  caption?: string;
  delay?: number;
  className?: string;
}

function ThinkingStepImage({
  src,
  alt = '',
  caption,
  delay = 0,
  className,
}: ThinkingStepImageProps) {
  const shape = useShape();
  const compact = useSize().variant === 'compact';
  return (
    <motion.div
      className={cn('mt-1.5', className)}
      initial={{ opacity: 0, filter: 'blur(4px)' }}
      animate={{ opacity: 1, filter: 'blur(0px)' }}
      transition={{
        opacity: { duration: 0.2, delay, ease: 'easeOut' },
        filter: { duration: 0.15, delay },
      }}
    >
      {/* Inset hairline keeps white-edged screenshots visible without
          changing the measured height. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- src is any caller URL; next/image needs that host in next.config and only works in Next */}
      <img
        src={src}
        alt={alt}
        className={cn(
          'w-full max-w-[200px] object-cover outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10',
          shape.container,
        )}
      />
      {caption && (
        <span
          className={cn(
            typeClass('caption', compact ? 'compact' : 'default'),
            'text-muted-foreground mt-1 block',
          )}
        >
          {caption}
        </span>
      )}
    </motion.div>
  );
}
ThinkingStepImage.displayName = 'ThinkingStepImage';

// ─── Exports ────────────────────────────────────────────────────────────────

export type {
  StepStatus,
  ThinkingStepDetailsProps,
  ThinkingStepImageProps,
  ThinkingStepProps,
  ThinkingStepSourceProps,
  ThinkingStepSourcesProps,
  ThinkingStepsContentProps,
  ThinkingStepsHeaderProps,
  ThinkingStepsProps,
};
export {
  ThinkingStep,
  ThinkingStepDetails,
  ThinkingStepImage,
  ThinkingStepSource,
  ThinkingStepSources,
  ThinkingSteps,
  ThinkingStepsContent,
  ThinkingStepsHeader,
};
