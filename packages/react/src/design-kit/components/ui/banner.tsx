'use client';

import {
  AnimatePresence,
  animate,
  motion,
  PresenceContext,
  useMotionValue,
  usePresence,
  useReducedMotion,
  useTransform,
  type ValueAnimationTransition,
} from 'motion/react';
import {
  type CSSProperties,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { fontWeights } from '../../lib/font-weight.ts';
import { type IconComponent, useIcons } from '../../lib/icon-context.tsx';
import { useShape } from '../../lib/shape-context.tsx';
import { SizeProvider, type SizeVariant, typeClass, useSize } from '../../lib/size-context.tsx';
import { spring } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';
import { Button, type ButtonProps } from './button.tsx';

// ---------------------------------------------------------------------------
// Banner owns the status color, icon and dismiss control; BannerTitle,
// BannerDescription and BannerActions fill the text column. contrast="low"
// colors only the icon over a neutral fill; "high" adds a light wash of the
// status color. Text stays foreground either way. Placement is pure CSS grid:
// actions trail a title-only banner and drop under the text when there is a
// description or the banner is narrower than 24rem.
// ---------------------------------------------------------------------------

type BannerStatus = 'default' | 'info' | 'success' | 'warning' | 'error';
type BannerContrast = 'low' | 'high';
type BannerVariant = 'inline' | 'fixed';

// useLayoutEffect warns on the server; the effect only measures, so skip it.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// The status color: icon fill and high-contrast wash. --info, --success and
// --warning ship with the component; error reuses --destructive.
const TONE: Record<BannerStatus, string> = {
  default: 'var(--foreground)',
  info: 'var(--info)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  error: 'var(--destructive)',
};

// Translucent fills take on the surface below. Grey reads darker than a hue
// at the same mix, so the neutral wash uses 8%.
function fillFor(status: BannerStatus, contrast: BannerContrast) {
  if (contrast === 'low') return 'var(--hover)';
  const amount = status === 'default' ? 8 : 12;
  return `color-mix(in oklab, var(--banner-tone) ${amount}%, transparent)`;
}

// ── Status glyphs ────────────────────────────────────────
// Colored statuses get filled shapes with the mark cut out: they carry color
// at 16–20px better than a 1.5px outline, and stay filled whatever icon set
// the app uses. The neutral default uses the icon set's outline info icon.

type ColoredStatus = Exclude<BannerStatus, 'default'>;

function StatusGlyph({ status, size }: { status: ColoredStatus; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      {status === 'warning' ? (
        <path
          d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
      ) : (
        <circle cx="12" cy="12" r="10.5" fill="currentColor" />
      )}
      <g
        className="stroke-background"
        strokeWidth={2.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {status === 'success' ? (
          <path d="m8.5 12.25 2.5 2.5 4.5-5" />
        ) : status === 'warning' ? (
          <path d="M12 9.5v3.5M12 17h.01" />
        ) : status === 'error' ? (
          <path d="M12 7.5v5M12 16.5h.01" />
        ) : (
          <path d="M12 16.5v-5M12 7.5h.01" />
        )}
      </g>
    </svg>
  );
}

// ── Motion ───────────────────────────────────────────────
// The banner's space (a one-row grid animating 0fr ↔ 1fr) and the banner
// itself move separately. Inline, the banner scales from its top edge in step
// with the row, so the row never clips it; a full-bleed fixed bar slides with
// the row instead. fr resolves from layout (no measuring, immune to scaled
// ancestors), and in a flex column the row takes back one gap so nothing
// jumps. Reduced motion keeps the fades and snaps the row.

/** Every value in the appear and dismiss. */
interface BannerMotionConfig {
  readonly appear: {
    /** The row opening. */
    readonly row: ValueAnimationTransition<number>;
    /** The banner fading in and growing. */
    readonly banner: ValueAnimationTransition<number>;
    /** The scale the banner grows from. */
    readonly fromScale: number;
  };
  readonly dismiss: {
    /** The row closing. The banner rides it. */
    readonly row: ValueAnimationTransition<number>;
    /** The scale the banner shrinks to, and how open the row is once it's
     *  gone, so the row never clips it. */
    readonly shrinkTo: number;
  };
}

/** The default appear and dismiss. Spread into a banner's `motion` prop to
 *  override single values. */
const bannerMotion: BannerMotionConfig = {
  appear: {
    row: { type: 'spring', duration: spring.moderate.duration * 2, bounce: 0 },
    banner: {
      type: 'spring',
      duration: spring.slow.duration,
      bounce: spring.slow.bounce,
      delay: spring.fast.duration,
    },
    fromScale: 0.4,
  },
  dismiss: {
    row: { duration: spring.moderate.exit.duration * 2, ease: 'easeInOut' },
    shrinkTo: 0.6,
  },
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Where keyboard focus goes when a banner holding it closes: the first
 *  focusable element after the banner, else the last one before it. */
function focusNeighbour(banner: HTMLElement) {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !banner.contains(el) && (el.checkVisibility?.() ?? true),
  );
  const after = candidates.find(
    (el) => banner.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  const before = candidates
    .filter((el) => banner.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)
    .pop();
  (after ?? before)?.focus({ preventScroll: true });
}

interface BannerMotionProps {
  fixed: boolean;
  reduceMotion: boolean;
  config: BannerMotionConfig;
  children: ReactNode;
}

function BannerMotion({ fixed, reduceMotion, config, children }: BannerMotionProps) {
  // A banner that is open on first render arrives already in place.
  const appear = useContext(PresenceContext)?.initial !== false;
  const [isPresent, safeToRemove] = usePresence();
  // `safeToRemove` changes every render while leaving and config may change
  // mid-flight; refs keep a parent re-render from restarting the animation.
  const safeToRemoveRef = useRef(safeToRemove);
  const configRef = useRef(config);
  useEffect(() => {
    safeToRemoveRef.current = safeToRemove;
    configRef.current = config;
  });
  const scaled = !fixed && !reduceMotion;
  // A fixed bar can't shrink from the window edges, so it slides with its row.
  const slides = fixed && !reduceMotion;

  // Every style derives from these, so row and banner render the same frame.
  const row = useMotionValue(appear ? 0 : 1);
  const shown = useMotionValue(appear ? 0 : 1);
  const scale = useMotionValue(appear && scaled ? config.appear.fromScale : 1);
  // A flex-column parent's gap, taken back as the row closes.
  const gap = useMotionValue(0);
  // Clip only when needed: the inline appear bounce overshoots full size
  // slightly and shouldn't be cut.
  const overflow = useMotionValue(fixed ? 'hidden' : 'visible');

  const gridTemplateRows = useTransform(row, (v) => `${v}fr`);
  // biome-ignore lint/style/noNonNullAssertion: The two-value input always yields a [row, gap] pair.
  const marginBottom = useTransform([row, gap], ([r, g]: number[]) => (r! - 1) * g!);
  const y = useTransform(row, (v) => (slides ? `${(v - 1) * 100}%` : '0%'));
  // A mostly-faded banner takes no clicks (no stray hits, no double dismiss).
  const pointerEvents = useTransform(shown, (v) => (v > 0.5 ? 'auto' : 'none'));

  const rootRef = useRef<HTMLDivElement | null>(null);
  // A layout effect, not a ref callback: refs attach before marginBottom's
  // transform subscribes, so a gap set there would miss the first paint and
  // the content below would jump by the gap.
  useIsoLayoutEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!parent) return;
    const style = getComputedStyle(parent);
    const column =
      parent.children.length > 1 &&
      style.display.endsWith('flex') &&
      style.flexDirection.startsWith('column');
    gap.set(column ? parseFloat(style.rowGap) || 0 : 0);
  }, [gap]);

  useEffect(() => {
    const { appear: enter, dismiss: leave } = configRef.current;

    if (isPresent) {
      // Appearing (or returning mid-dismiss): the row opens; inline, the
      // banner fades and grows behind it, a fixed bar slides in with it.
      overflow.set(fixed ? 'hidden' : 'visible');
      const open = animate(row, 1, reduceMotion ? { duration: 0 } : enter.row);
      if (slides) {
        const follow = row.on('change', (v) => shown.set(v));
        return () => {
          follow();
          open.stop();
        };
      }
      const show = animate(shown, 1, reduceMotion ? spring.fast : enter.banner);
      const grow = scaled ? animate(scale, 1, enter.banner) : undefined;
      return () => {
        open.stop();
        show.stop();
        grow?.stop();
      };
    }

    // Leaving with keyboard focus inside: hand it to a neighbour, so it
    // doesn't fall back to the top of the page when the banner unmounts.
    const root = rootRef.current;
    if (root?.contains(document.activeElement)) focusNeighbour(root);

    if (reduceMotion) {
      const hide = animate(shown, 0, spring.fast.exit);
      hide.then(() => safeToRemoveRef.current?.());
      return () => hide.stop();
    }

    // Dismissing: the row closes and the banner rides it. Inline, it fades
    // and shrinks toward `shrinkTo` so it's never taller than the row. Starts
    // from the current values, so a dismiss mid-appear doesn't jump.
    overflow.set('hidden');
    const end = fixed ? 0 : Math.min(leave.shrinkTo, 0.99);
    const rowFrom = row.get();
    const shownFrom = shown.get();
    const scaleFrom = scale.get();
    const unfollow = row.on('change', (v) => {
      const left = rowFrom > end ? (v - end) / (rowFrom - end) : rowFrom > 0 ? v / rowFrom : 0;
      shown.set(shownFrom * Math.min(1, Math.max(0, left)));
      if (scaled) scale.set(Math.min(scaleFrom, Math.max(v, end)));
    });
    const close = animate(row, 0, leave.row);
    close.then(() => safeToRemoveRef.current?.());
    return () => {
      unfollow();
      close.stop();
    };
  }, [isPresent, reduceMotion, fixed, scaled, slides, row, shown, scale, overflow]);

  return (
    <motion.div
      ref={rootRef}
      style={{ gridTemplateRows, marginBottom, overflow }}
      // w-full: as a size container the banner can't size to its content.
      // The clip sits on the grid, not the track item: below 1fr Chrome sizes
      // the track to f² of the content (0.5fr renders a quarter).
      className={cn('grid w-full', fixed && 'sticky top-0 z-40')}
    >
      <div className="min-h-0">
        <motion.div style={{ opacity: shown, scale, y, pointerEvents, transformOrigin: 'top' }}>
          {children}
        </motion.div>
      </div>
    </motion.div>
  );
}

// ── Banner ───────────────────────────────────────────────

interface BannerProps extends HTMLAttributes<HTMLDivElement> {
  /** Which status color the banner carries. @default "default" */
  status?: BannerStatus;
  /** "low" — neutral fill, colored icon. "high" — a light wash of the status
   *  color behind the text. @default "low" */
  contrast?: BannerContrast;
  /** "inline" — a rounded block in the flow of the page. "fixed" — a
   *  full-bleed bar that sticks to the top of its scroll container and pushes
   *  the content below it down. @default "inline" */
  variant?: BannerVariant;
  /** Replaces the status icon. Rendered in the status color. */
  icon?: IconComponent;
  /** Shows a dismiss (✕) button. */
  dismissible?: boolean;
  /** Called when the ✕ is pressed. */
  onDismiss?: () => void;
  /** Accessible name for the ✕. @default "Dismiss" */
  dismissLabel?: string;
  /** Controls visibility. Omitted, the banner hides itself when dismissed.
   *  Either way, closing collapses its height so the content below slides up. */
  open?: boolean;
  /** Pins the banner to one step of the size ladder. Omitted, it follows the
   *  surrounding SizeProvider. */
  size?: SizeVariant;
  /** Overrides the appear and dismiss values for this banner. Spread
   *  `bannerMotion` to change one and keep the rest. */
  motion?: BannerMotionConfig;
}

const Banner = forwardRef<HTMLDivElement, BannerProps>(
  (
    {
      status = 'default',
      contrast = 'low',
      variant = 'inline',
      icon: Icon,
      dismissible = false,
      onDismiss,
      dismissLabel = 'Dismiss',
      open: openProp,
      size,
      motion: motionConfig = bannerMotion,
      role,
      className,
      style,
      children,
      ...props
    },
    ref,
  ) => {
    const shape = useShape();
    const sizeClasses = useSize(size);
    const compact = sizeClasses.variant === 'compact';
    const icons = useIcons();
    const XIcon = icons.x;
    const InfoIcon = icons.info;
    const reduceMotion = useReducedMotion() ?? false;
    const fixed = variant === 'fixed';

    const [openState, setOpenState] = useState(true);
    const open = openProp ?? openState;

    const handleDismiss = () => {
      onDismiss?.();
      if (openProp === undefined) setOpenState(false);
    };

    const iconSize = compact ? 16 : 20;
    // Custom icons and the default status use an outline icon; colored
    // statuses get the filled glyph.
    const OutlineIcon = Icon ?? (status === 'default' ? InfoIcon : undefined);

    const body = (
      <div
        ref={ref}
        // Errors and warnings interrupt a screen reader; the rest wait.
        role={role ?? (status === 'error' || status === 'warning' ? 'alert' : 'status')}
        data-slot="banner"
        data-status={status}
        data-contrast={contrast}
        data-variant={variant}
        className={cn(
          'group/banner @container/banner relative grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center text-foreground',
          // With a description, the icon and ✕ hold to the title line.
          'has-data-[slot=banner-description]:items-start',
          compact ? 'p-3' : 'p-4',
          // A fixed bar runs edge to edge: square corners.
          !fixed && shape.container,
          className,
        )}
        style={
          {
            '--banner-tone': TONE[status],
            '--banner-fill': fillFor(status, contrast),
            // A fixed bar stays opaque over content scrolling under it.
            backgroundColor: fixed ? 'var(--background)' : undefined,
            backgroundImage: 'linear-gradient(var(--banner-fill), var(--banner-fill))',
            ...style,
          } as CSSProperties
        }
        {...props}
      >
        {/* The glyph box is one title line tall, so it lines up with the
            first line whether it centres or tops. */}
        <span
          aria-hidden="true"
          className={cn(
            'col-start-1 row-start-1 flex items-center justify-center text-[color:var(--banner-tone)]',
            compact ? 'mr-2.5 h-[18px]' : 'mr-3 h-5',
          )}
        >
          {OutlineIcon ? (
            <OutlineIcon size={iconSize} strokeWidth={1.5} />
          ) : (
            status !== 'default' && <StatusGlyph status={status} size={iconSize} />
          )}
        </span>

        {children}

        {dismissible && (
          <button
            type="button"
            onClick={handleDismiss}
            aria-label={dismissLabel}
            className={cn(
              'col-start-4 row-start-1 flex size-7 cursor-pointer items-center justify-center text-muted-foreground outline-none transition-colors duration-80 hover:bg-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]',
              // Pulled into the padding so the glyph, not the 28px box, sits
              // on the title line and the inset edge.
              compact ? '-my-[5px] -mr-1.5 ml-1.5' : '-my-1 -mr-1.5 ml-2',
              shape.button,
            )}
          >
            <XIcon size={compact ? 13 : 15} strokeWidth={1.5} />
          </button>
        )}
      </div>
    );

    const banner = (
      <AnimatePresence initial={false}>
        {open && (
          <BannerMotion
            key="banner"
            fixed={fixed}
            reduceMotion={reduceMotion}
            config={motionConfig}
          >
            {body}
          </BannerMotion>
        )}
      </AnimatePresence>
    );

    return size ? <SizeProvider size={size}>{banner}</SizeProvider> : banner;
  },
);

Banner.displayName = 'Banner';

// ── BannerTitle ──────────────────────────────────────────

const BannerTitle = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  ({ className, style, ...props }, ref) => {
    const compact = useSize().variant === 'compact';
    return (
      <p
        ref={ref}
        data-slot="banner-title"
        className={cn(
          'col-start-2 row-start-1 min-w-0 text-foreground',
          typeClass('subtitle', compact ? 'compact' : 'default'),
          className,
        )}
        style={{ fontVariationSettings: fontWeights.semibold, ...style }}
        {...props}
      />
    );
  },
);

BannerTitle.displayName = 'BannerTitle';

// ── BannerDescription ────────────────────────────────────
// Foreground, not muted: muted grey drops under 4.5:1 on the banner fills.

const BannerDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => {
    const compact = useSize().variant === 'compact';
    return (
      <p
        ref={ref}
        data-slot="banner-description"
        className={cn(
          'col-start-2 row-start-2 mt-0.5 min-w-0 text-foreground',
          typeClass('subtitle', compact ? 'compact' : 'default'),
          className,
        )}
        {...props}
      />
    );
  },
);

BannerDescription.displayName = 'BannerDescription';

// ── BannerActions ────────────────────────────────────────
// Trails the title row (pulled into the padding so 28px buttons don't grow a
// one-line banner); drops under the text with a description or below 24rem.

const BannerActions = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const compact = useSize().variant === 'compact';
    return (
      <div
        ref={ref}
        data-slot="banner-actions"
        className={cn(
          'col-start-3 row-start-1 flex flex-wrap items-center gap-2',
          compact ? '-my-[5px] ml-2.5' : '-my-1 ml-3',
          // With a description
          'group-has-data-[slot=banner-description]/banner:col-start-2 group-has-data-[slot=banner-description]/banner:row-start-3 group-has-data-[slot=banner-description]/banner:my-0 group-has-data-[slot=banner-description]/banner:ml-0',
          compact
            ? 'group-has-data-[slot=banner-description]/banner:mt-1.5'
            : 'group-has-data-[slot=banner-description]/banner:mt-2',
          // Narrow banner
          '@max-sm/banner:col-start-2 @max-sm/banner:row-start-3 @max-sm/banner:my-0 @max-sm/banner:ml-0',
          compact ? '@max-sm/banner:mt-1.5' : '@max-sm/banner:mt-2',
          className,
        )}
        {...props}
      />
    );
  },
);

BannerActions.displayName = 'BannerActions';

// ── BannerAction ─────────────────────────────────────────
// A compact 28px Button, so a one-line banner doesn't grow. Ghost text steps
// up from muted to hold 4.5:1 on every banner fill.

type BannerActionVariant = 'primary' | 'secondary' | 'ghost';

// Visual order by variant: trailing the title the strongest goes last; under
// the text it leads. Tab order follows the markup, so write primary first.
const BANNER_ACTION_ORDER: Record<BannerActionVariant, string> = {
  primary: 'order-3 group-has-data-[slot=banner-description]/banner:order-1 @max-sm/banner:order-1',
  secondary: 'order-2',
  ghost: 'order-1 group-has-data-[slot=banner-description]/banner:order-3 @max-sm/banner:order-3',
};

interface BannerActionProps
  extends Omit<ButtonProps, 'variant' | 'size' | 'asChild' | 'render' | 'nativeButton'> {
  /** @default "secondary" */
  variant?: BannerActionVariant;
  /** Renders a link instead of a button. */
  href?: string;
  /** Opens the href in a new tab. */
  external?: boolean;
}

const BannerAction = forwardRef<HTMLButtonElement, BannerActionProps>(
  ({ variant = 'secondary', href, external = false, className, children, ...props }, ref) => {
    const classes = cn(
      BANNER_ACTION_ORDER[variant],
      variant === 'ghost' && 'text-foreground',
      className,
    );

    if (href) {
      return (
        <Button
          ref={ref}
          asChild
          variant={variant}
          size="compact"
          data-slot="banner-action"
          className={classes}
          {...props}
        >
          <a
            href={href}
            target={external ? '_blank' : undefined}
            rel={external ? 'noopener noreferrer' : undefined}
          >
            {children}
          </a>
        </Button>
      );
    }

    return (
      <Button
        ref={ref}
        type="button"
        variant={variant}
        size="compact"
        data-slot="banner-action"
        className={classes}
        {...props}
      >
        {children}
      </Button>
    );
  },
);

BannerAction.displayName = 'BannerAction';

export type {
  BannerActionProps,
  BannerActionVariant,
  BannerContrast,
  BannerMotionConfig,
  BannerProps,
  BannerStatus,
  BannerVariant,
};
export { Banner, BannerAction, BannerActions, BannerDescription, BannerTitle, bannerMotion };
