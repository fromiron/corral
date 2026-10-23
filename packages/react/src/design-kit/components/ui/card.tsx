'use client';

import {
  Children,
  cloneElement,
  createContext,
  forwardRef,
  type HTMLAttributes,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
} from 'react';

const Link = 'a';

import { useFluidHover, useRegisterFluidHoverItem } from '../../hooks/use-fluid-hover.ts';
import { fontWeights } from '../../lib/font-weight.ts';
import { type IconComponent, useIcons } from '../../lib/icon-context.tsx';
import { useShape } from '../../lib/shape-context.tsx';
import { SizeProvider, type SizeVariant, typeClass, useSize } from '../../lib/size-context.tsx';
import { cn } from '../../lib/utils.ts';
import { FluidHoverHighlight } from './fluid-hover-highlight.tsx';

// ---------------------------------------------------------------------------
// Compositional card (Card, CardHeader, CardTitle, CardDescription, CardAction,
// CardContent, CardFooter, with `data-slot`s). CardGroup owns layout (list,
// inline rows, or grid) and the fluid hover highlight. Surfaces are transparent
// and borderless by default, relying on hairline dividers and the highlight.
// ---------------------------------------------------------------------------

type CardOrientation = 'card' | 'inline';
type CardBorder = 'none' | 'outlined';

// ── Group context ────────────────────────────────────────

interface CardGroupContextValue {
  registerItem: (index: number, element: HTMLElement | null) => void;
  activeIndex: number | null;
  /** Selected card index, or -1; its neighbours drop the adjoining hairline. */
  selectedIndex: number;
  orientation: CardOrientation;
  columns: number;
  count: number;
  /** Individual cards carry their own border/tile shape (separated grids). */
  separated: boolean;
  /** Inner hairline dividers are drawn between adjacent cards. */
  divided: boolean;
  outlined: boolean;
}

const CardGroupContext = createContext<CardGroupContextValue | null>(null);

// ── Per-card context ─────────────────────────────────────

interface CardContextValue {
  emphasized: boolean;
  orientation: CardOrientation;
  clickable: boolean;
  /** Inline cards with a CardImage stack the footer under the text. */
  hasImage: boolean;
}

const CardContext = createContext<CardContextValue>({
  emphasized: false,
  orientation: 'card',
  clickable: false,
  hasImage: false,
});

// ── CardGroup ────────────────────────────────────────────

interface CardGroupProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onDrag'> {
  /** "card" stacks content vertically; "inline" lays it out as a row.
   *  @default "card" */
  orientation?: CardOrientation;
  /** Grid columns; >1 enables 2-D fluid hover. @default 1 */
  columns?: number;
  /** "outlined" draws one shared frame, or one per card when `separated`.
   *  @default "none" */
  border?: CardBorder;
  /** Separate tiles with a gap instead of one divided block. @default false */
  separated?: boolean;
  /** Enable the magnetic fluid-hover highlight. @default true */
  fluidHover?: boolean;
}

const CardGroup = forwardRef<HTMLDivElement, CardGroupProps>(
  (
    {
      orientation = 'card',
      columns = 1,
      border = 'none',
      separated = false,
      fluidHover = true,
      className,
      children,
      ...props
    },
    ref,
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const shape = useShape();

    const axis = columns > 1 ? 'xy' : 'y';
    // Card grids have generous whitespace, so only route gap clicks close by.
    const hover = useFluidHover(containerRef, { axis, gapClick: { maxDistance: 16 } });
    const { activeIndex, handlers, registerItem } = hover;

    // The group assigns each child its fluid hover index.
    const childArray = Children.toArray(children).filter(isValidElement);
    const count = childArray.length;
    const indexed = childArray.map((child, i) =>
      cloneElement(child as ReactElement<{ index?: number }>, { index: i }),
    );
    const selectedIndex = childArray.findIndex(
      (child) => (child.props as { selected?: boolean }).selected,
    );

    const outlined = border === 'outlined';
    const divided = !separated;

    const contextValue = useMemo<CardGroupContextValue>(
      () => ({
        registerItem,
        activeIndex,
        selectedIndex,
        orientation,
        columns,
        count,
        separated,
        divided,
        outlined,
      }),
      [
        registerItem,
        activeIndex,
        selectedIndex,
        orientation,
        columns,
        count,
        separated,
        divided,
        outlined,
      ],
    );

    return (
      <CardGroupContext.Provider value={contextValue}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: This routes pointer gaps to existing keyboard-operable cards. */}
        <div
          ref={(node) => {
            (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
            if (typeof ref === 'function') ref(node);
            else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
          }}
          {...props}
          data-slot="card-group"
          data-orientation={orientation}
          className={cn(
            'relative grid',
            // The shared frame clips highlight and dividers; tiles clip themselves.
            outlined && !separated && `border border-border/60 overflow-hidden ${shape.container}`,
            separated ? 'gap-2' : 'gap-0',
            className,
          )}
          style={{
            gridTemplateColumns: `repeat(${Math.max(1, columns)}, minmax(0, 1fr))`,
          }}
          onMouseEnter={fluidHover ? handlers.onMouseEnter : undefined}
          onMouseMove={fluidHover ? handlers.onMouseMove : undefined}
          onMouseLeave={fluidHover ? handlers.onMouseLeave : undefined}
          onClick={fluidHover ? handlers.onClick : undefined}
        >
          <FluidHoverHighlight
            hover={hover}
            hidden={!fluidHover}
            className={cn('z-0', shape.container)}
          />

          {indexed}
        </div>
      </CardGroupContext.Provider>
    );
  },
);

CardGroup.displayName = 'CardGroup';

// ── Card ─────────────────────────────────────────────────

interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onClick'> {
  /** Makes the whole card an interactive target; fluid hover previews it.
   *  Renders a stretched link when `href` is set, else a stretched button. */
  onClick?: () => void;
  href?: string;
  external?: boolean;
  /** Accessible name for the stretched link/button (the title isn't used). */
  label?: string;
  /** Persistent selected state, on top of the transient fluid hover. */
  selected?: boolean;
  disabled?: boolean;
  /** Shows a dismiss (✕) button in the corner. */
  dismissible?: boolean;
  /** Show the dismiss control only on hover/focus. @default true */
  dismissOnHover?: boolean;
  onDismiss?: () => void;
  /** Pins the card to one size step; defaults to the surrounding SizeProvider. */
  size?: SizeVariant;
  /** Injected by CardGroup — do not set by hand. */
  index?: number;
}

const Card = forwardRef<HTMLDivElement, CardProps>(
  (
    {
      onClick,
      href,
      external,
      label,
      selected = false,
      disabled = false,
      dismissible = false,
      dismissOnHover = true,
      onDismiss,
      size,
      index,
      className,
      children,
      ...props
    },
    ref,
  ) => {
    const internalRef = useRef<HTMLDivElement>(null);
    const shape = useShape();
    // Uses the prop directly: this card renders the SizeProvider its parts read.
    const sizeClasses = useSize(size);
    const compact = sizeClasses.variant === 'compact';
    const group = useContext(CardGroupContext);
    const icons = useIcons();
    const XIcon = icons.x;

    const orientation = group?.orientation ?? 'card';
    const columns = group?.columns ?? 1;
    const count = group?.count ?? 1;
    const separated = group?.separated ?? true;
    const divided = group?.divided ?? false;
    const outlined = group?.outlined ?? false;
    const activeIndex = group?.activeIndex ?? null;
    const selectedIndex = group?.selectedIndex ?? -1;

    // Depend on the stable callback, not the context (which changes every hover
    // frame). Only clickable cards join the highlight.
    const registerItem = href || onClick ? group?.registerItem : undefined;
    useRegisterFluidHoverItem(registerItem, index, internalRef);

    // Hairlines toward the neighbour below / right, dropped next to the active
    // or selected card so its fill reads clean.
    const col = index !== undefined ? index % columns : 0;
    const hasBelow = index !== undefined && index + columns < count;
    const hasRight = index !== undefined && col < columns - 1 && index + 1 < count;
    const self = index ?? -1;
    const touchesBelow = (i: number) => i === self || i === self + columns;
    const touchesRight = (i: number) => i === self || i === self + 1;
    const showBottom =
      divided && hasBelow && !(touchesBelow(activeIndex ?? -1) || touchesBelow(selectedIndex));
    const showRight =
      divided && hasRight && !(touchesRight(activeIndex ?? -1) || touchesRight(selectedIndex));

    const isInline = orientation === 'inline';
    // Matches by displayName too, since HMR can duplicate module identity.
    const isCardImage = (child: ReactNode) =>
      isValidElement(child) &&
      (child.type === CardImage ||
        (child.type as { displayName?: string })?.displayName === 'CardImage');
    const hasImage = Children.toArray(children).some(isCardImage);
    const inlineImage = isInline && hasImage;
    const clickable = !!href || !!onClick;
    // Hover doesn't bold the title; only selection does.
    const emphasized = selected;

    // Standalone cards are always rounded and clipped; grouped ones only when
    // separated and outlined (otherwise the group frame handles it).
    const tileShape = !group
      ? cn(shape.container, 'overflow-hidden')
      : separated && outlined
        ? cn(shape.container, 'overflow-hidden border border-border/60')
        : '';

    // A stretched overlay makes the whole card clickable without nesting
    // controls in a button/anchor. Disabled cards drop it so it can't be tabbed to.
    const overlay =
      clickable && !disabled ? (
        href ? (
          <Link
            href={href}
            onClick={onClick}
            target={external ? '_blank' : undefined}
            rel={external ? 'noopener noreferrer' : undefined}
            aria-label={label}
            className="absolute inset-0 z-20 outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)] rounded-[inherit]"
          />
        ) : (
          <button
            type="button"
            onClick={onClick}
            aria-label={label}
            aria-pressed={selected || undefined}
            className="absolute inset-0 z-20 outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)] rounded-[inherit]"
          />
        )
      ) : null;

    const cardContext = useMemo<CardContextValue>(
      () => ({ emphasized, orientation, clickable, hasImage }),
      [emphasized, orientation, clickable, hasImage],
    );

    // Inline image cards put the non-image parts in a vertically centred column.
    let body: ReactNode = children;
    if (inlineImage) {
      const parts = Children.toArray(children);
      const image = parts.find(isCardImage);
      const rest = parts.filter((part) => part !== image);
      body = (
        <>
          {image}
          <div
            className={cn(
              'flex min-w-0 flex-1 flex-col justify-center gap-2',
              compact ? 'py-2.5 pr-3' : 'py-3.5 pr-4',
            )}
          >
            {rest}
          </div>
        </>
      );
    }

    const card = (
      <CardContext.Provider value={cardContext}>
        <div
          ref={(node) => {
            (internalRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
            if (typeof ref === 'function') ref(node);
            else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
          }}
          data-slot="card"
          data-fluid-hover-index={index}
          data-selected={selected || undefined}
          data-orientation={orientation}
          aria-disabled={disabled || undefined}
          className={cn(
            'group/card relative z-10 min-w-0 min-h-[60px]',
            inlineImage
              ? cn('flex flex-row items-center', compact ? 'gap-2.5' : 'gap-3')
              : isInline
                ? cn('flex flex-row items-center', compact ? 'gap-2.5 pl-3' : 'gap-3 pl-4')
                : cn('flex flex-col', compact ? 'pb-3' : 'pb-4'),
            // No group highlight, so standalone cards tint on hover.
            !group && clickable && !disabled && 'transition-colors duration-80 hover:bg-hover',
            // Inline headers make room for the corner dismiss while it's shown.
            dismissible &&
              isInline &&
              (dismissOnHover
                ? '[&:hover_[data-slot=card-header]]:pr-10 [&:focus-within_[data-slot=card-header]]:pr-10'
                : '[&_[data-slot=card-header]]:pr-10'),
            tileShape,
            disabled && 'opacity-50 pointer-events-none',
            className,
          )}
          {...props}
        >
          {/* Layers: fill + dividers -z-10, overlay z-20, actions/dismiss z-30. */}
          {selected && (
            <span
              aria-hidden
              className={cn(
                'absolute inset-0 -z-10 bg-active pointer-events-none',
                shape.container,
              )}
            />
          )}

          {/* The vertical hairline stops 1px short of the horizontal one, so
              two 60% lines don't stack into a brighter crossing pixel. */}
          {showBottom && (
            <span
              aria-hidden
              className="absolute inset-x-0 bottom-0 h-px bg-border/60 pointer-events-none -z-10"
            />
          )}
          {showRight && (
            <span
              aria-hidden
              className={cn(
                'absolute top-0 right-0 w-px bg-border/60 pointer-events-none -z-10',
                showBottom ? 'bottom-px' : 'bottom-0',
              )}
            />
          )}

          {overlay}

          {body}

          {dismissible && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss"
              className={cn(
                'absolute right-2 top-2 z-30 flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground cursor-pointer outline-none transition-colors duration-80 focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]',
                // Over an image the icon needs its own backdrop.
                hasImage ? 'bg-card/70 backdrop-blur-sm hover:bg-card' : 'hover:bg-hover',
                // pointer-events gates with opacity so the hidden control can't
                // swallow taps (no hover on touch); keyboard focus still reaches it.
                dismissOnHover &&
                  'pointer-events-none opacity-0 transition-opacity duration-80 group-hover/card:pointer-events-auto group-hover/card:opacity-100 group-focus-within/card:pointer-events-auto group-focus-within/card:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100',
                shape.button,
              )}
            >
              <XIcon size={compact ? 13 : 15} strokeWidth={1.5} />
            </button>
          )}
        </div>
      </CardContext.Provider>
    );

    return size ? <SizeProvider size={size}>{card}</SizeProvider> : card;
  },
);

Card.displayName = 'Card';

// ── CardHeader ───────────────────────────────────────────
// Title + description, with CardAction pinned top-right.

const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { orientation, hasImage } = useContext(CardContext);
    const inlineImage = orientation === 'inline' && hasImage;
    const sizeClasses = useSize();
    const compact = sizeClasses.variant === 'compact';
    return (
      <div
        ref={ref}
        data-slot="card-header"
        className={cn(
          'grid auto-rows-min items-start gap-1 has-data-[slot=card-action]:grid-cols-[1fr_auto]',
          inlineImage
            ? 'min-w-0'
            : orientation === 'inline'
              ? cn('min-w-0 flex-1', compact ? 'py-2.5' : 'py-3.5')
              : compact
                ? 'px-3 pt-3'
                : 'px-4 pt-4',
          className,
        )}
        {...props}
      />
    );
  },
);

CardHeader.displayName = 'CardHeader';

// ── CardTitle ────────────────────────────────────────────

const CardTitle = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(
  ({ className, children, ...props }, ref) => {
    const { emphasized, orientation } = useContext(CardContext);
    const sizeClasses = useSize();
    const compact = sizeClasses.variant === 'compact';
    // Inline rows trim the title to cap height to centre it against media.
    const trim = orientation === 'inline' ? '[text-box:trim-both_cap_alphabetic]' : '';
    // An invisible semibold copy reserves the width so the weight change never
    // reflows. A grid can't ellipsize, so the cell spans carry the ellipsis
    // (inheriting a consumer's `truncate` nowrap); minmax(0,1fr) keeps it inside.
    return (
      <span
        ref={ref}
        data-slot="card-title"
        className={cn(
          'inline-grid grid-cols-[minmax(0,1fr)]',
          typeClass('subtitle', compact ? 'compact' : 'default'),
          className,
        )}
        {...props}
      >
        <span
          className={cn(
            'col-start-1 row-start-1 invisible min-w-0 overflow-hidden text-ellipsis',
            trim,
          )}
          style={{ fontVariationSettings: fontWeights.semibold }}
          aria-hidden="true"
        >
          {children}
        </span>
        <span
          className={cn(
            'col-start-1 row-start-1 min-w-0 overflow-hidden text-ellipsis text-foreground transition-[font-variation-settings] duration-80',
            trim,
          )}
          style={{
            fontVariationSettings: emphasized ? fontWeights.semibold : fontWeights.normal,
          }}
        >
          {children}
        </span>
      </span>
    );
  },
);

CardTitle.displayName = 'CardTitle';

// ── CardDescription ──────────────────────────────────────

const CardDescription = forwardRef<HTMLParagraphElement, HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => {
    const sizeClasses = useSize();
    const compact = sizeClasses.variant === 'compact';
    return (
      <p
        ref={ref}
        data-slot="card-description"
        className={cn(
          'text-muted-foreground',
          typeClass('subtitle', compact ? 'compact' : 'default'),
          className,
        )}
        {...props}
      />
    );
  },
);

CardDescription.displayName = 'CardDescription';

// ── CardAction ───────────────────────────────────────────
// z-30 keeps controls clickable above the stretched overlay.

const CardAction = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="card-action"
      className={cn(
        'relative z-30 col-start-2 row-span-2 row-start-1 self-start justify-self-end',
        className,
      )}
      {...props}
    />
  ),
);

CardAction.displayName = 'CardAction';

// ── CardContent ──────────────────────────────────────────

const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { orientation } = useContext(CardContext);
    const sizeClasses = useSize();
    const compact = sizeClasses.variant === 'compact';
    return (
      <div
        ref={ref}
        data-slot="card-content"
        className={cn(
          orientation === 'inline' ? '' : compact ? 'px-3 pt-2.5' : 'px-4 pt-3',
          className,
        )}
        {...props}
      />
    );
  },
);

CardContent.displayName = 'CardContent';

// ── CardFooter ───────────────────────────────────────────
// Actions row, z-30 above the overlay. Trailing slot in inline cards.

const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { orientation, hasImage } = useContext(CardContext);
    const inlineImage = orientation === 'inline' && hasImage;
    const sizeClasses = useSize();
    const compact = sizeClasses.variant === 'compact';
    return (
      <div
        ref={ref}
        data-slot="card-footer"
        className={cn(
          'relative z-30 flex items-center gap-1',
          inlineImage
            ? 'flex-wrap'
            : orientation === 'inline'
              ? cn('shrink-0 ml-auto', compact ? 'pr-3' : 'pr-4')
              : cn('flex-wrap', compact ? 'px-3 pt-2.5' : 'px-4 pt-3'),
          className,
        )}
        {...props}
      />
    );
  },
);

CardFooter.displayName = 'CardFooter';

// ── CardMedia ────────────────────────────────────────────
// A leading icon or logo; a tuple renders a connected logo pair.

type CardLogo = string | [string, string];

interface CardMediaProps {
  logo?: CardLogo;
  logoAlt?: string;
  icon?: IconComponent;
  size?: number;
  className?: string;
}

function CardMedia({ logo, logoAlt, icon: Icon, size = 22, className }: CardMediaProps) {
  const { orientation } = useContext(CardContext);
  const shape = useShape();
  const sizeClasses = useSize();
  const compact = sizeClasses.variant === 'compact';
  // Stacked: mb-2 + the header's gap-1 makes a 12px gap below.
  const wrap = cn(orientation === 'inline' ? '' : 'mb-2', className);

  if (logo) {
    const logos = Array.isArray(logo) ? logo : [logo];
    return (
      <span
        data-slot="card-media"
        className={cn('inline-flex items-center gap-1.5 shrink-0', wrap)}
      >
        {logos.map((src, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: A fixed one-or-two logo tuple can contain duplicate sources.
          <span key={i} className="inline-flex items-center gap-1.5">
            {i > 0 && <span aria-hidden className="w-2 h-px bg-border" />}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={logoAlt ?? ''}
              width={size}
              height={size}
              className={cn(
                'object-contain outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10',
                shape.bg,
              )}
              style={{ width: size, height: size }}
            />
          </span>
        ))}
      </span>
    );
  }
  if (Icon) {
    // A translucent tint, not a solid surface, so it blends over the highlight.
    return (
      <span
        data-slot="card-media"
        className={cn(
          'inline-flex items-center justify-center shrink-0 size-8 bg-hover',
          shape.bg,
          wrap,
        )}
      >
        <Icon size={compact ? 16 : 18} strokeWidth={1.5} className="text-muted-foreground" />
      </span>
    );
  }
  return null;
}

// ── CardImage ────────────────────────────────────────────
// Full-bleed image: a top banner when stacked, a leading image when inline.

interface CardImageProps {
  src: string;
  alt?: string;
  className?: string;
}

function CardImage({ src, alt, className }: CardImageProps) {
  const { orientation } = useContext(CardContext);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt ?? ''}
      data-slot="card-image"
      // Fixed 2px radius in every layout. The inset outline keeps pale images
      // edged without changing geometry.
      className={cn(
        'object-cover rounded-[2px] outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10',
        orientation === 'inline' ? 'size-40 shrink-0' : 'w-full aspect-[16/9]',
        className,
      )}
    />
  );
}

// Card detects image children by this name as well as by identity.
CardImage.displayName = 'CardImage';

// ── CardEyebrow ──────────────────────────────────────────
// Kept for backward compatibility.

/** @deprecated No eyebrows: a card starts with its title. */
const CardEyebrow = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => {
    const compact = useSize().variant === 'compact';
    return (
      <span
        ref={ref}
        data-slot="card-eyebrow"
        className={cn(
          typeClass('caption', compact ? 'compact' : 'default'),
          'text-muted-foreground',
          className,
        )}
        style={{ fontVariationSettings: fontWeights.semibold }}
        {...props}
      />
    );
  },
);

CardEyebrow.displayName = 'CardEyebrow';

// ── CardFeature ──────────────────────────────────────────
// Icon + title + description row for feature lists.

interface CardFeatureProps {
  icon?: IconComponent;
  title: string;
  description?: string;
}

function CardFeature({ icon: Icon, title, description }: CardFeatureProps) {
  const sizeClasses = useSize();
  const compact = sizeClasses.variant === 'compact';
  return (
    <div data-slot="card-feature" className={cn('flex items-start', sizeClasses.gap)}>
      {Icon && (
        <Icon
          size={sizeClasses.icon}
          strokeWidth={1.5}
          className="mt-0.5 shrink-0 text-muted-foreground"
        />
      )}
      <div className="flex flex-col gap-0.5 min-w-0">
        <span
          className={cn('text-foreground [text-box:trim-both_cap_alphabetic]', sizeClasses.text)}
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {title}
        </span>
        {description && (
          <span
            className={cn(
              'text-muted-foreground',
              typeClass('caption', compact ? 'compact' : 'default'),
            )}
          >
            {description}
          </span>
        )}
      </div>
    </div>
  );
}

// ── CardButton ───────────────────────────────────────────
// Self-contained so Card doesn't depend on Button. A link when `href` is set.

type CardButtonVariant = 'primary' | 'secondary' | 'ghost' | 'link';

const CARD_BUTTON_VARIANTS: Record<CardButtonVariant, string> = {
  primary: 'bg-foreground text-background hover:bg-foreground/90 active:bg-foreground/80',
  secondary: 'bg-accent text-foreground hover:bg-accent/80 active:bg-accent',
  ghost: 'text-muted-foreground hover:text-foreground hover:bg-hover active:bg-active',
  link: 'text-foreground underline-offset-4 hover:underline !px-0 !h-auto',
};

interface CardButtonProps {
  children: React.ReactNode;
  onClick?: () => void;
  href?: string;
  variant?: CardButtonVariant;
  icon?: IconComponent;
  iconPosition?: 'start' | 'end';
  /** Opens the href in a new tab and appends an outward arrow glyph. */
  external?: boolean;
  disabled?: boolean;
}

function CardButton({
  children,
  onClick,
  href,
  variant = 'ghost',
  icon: Icon,
  iconPosition,
  external = false,
  disabled = false,
}: CardButtonProps) {
  const shape = useShape();
  const icons = useIcons();
  const ArrowRight = icons['arrow-right'];
  const sizeClasses = useSize();
  const compact = sizeClasses.variant === 'compact';
  const position = iconPosition ?? (external ? 'end' : 'start');

  const glyph = Icon ? (
    <Icon
      size={compact ? 12 : 14}
      strokeWidth={1.5}
      className="shrink-0 transition-[stroke-width] duration-80 group-hover/action:stroke-[2]"
    />
  ) : null;
  const externalGlyph = external ? (
    <ArrowRight
      size={13}
      strokeWidth={1.5}
      className="shrink-0 -rotate-45 transition-[stroke-width] duration-80 group-hover/action:stroke-[2]"
    />
  ) : null;

  const inner = (
    <>
      {position === 'start' && glyph}
      <span className="[text-box:trim-both_cap_alphabetic]">{children}</span>
      {position === 'end' && glyph}
      {externalGlyph}
    </>
  );

  const classes = cn(
    'group/action relative z-30 inline-flex items-center justify-center gap-1.5 h-7 px-2.5 cursor-pointer outline-none',
    typeClass('caption', compact ? 'compact' : 'default'),
    'transition-colors duration-80',
    'focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]',
    'disabled:opacity-50 disabled:pointer-events-none',
    shape.button,
    CARD_BUTTON_VARIANTS[variant],
  );

  if (href) {
    return (
      <Link
        href={href}
        onClick={onClick}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
        className={classes}
        style={{ fontVariationSettings: fontWeights.normal }}
      >
        {inner}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={classes}
      style={{ fontVariationSettings: fontWeights.normal }}
    >
      {inner}
    </button>
  );
}

export type { CardButtonProps, CardButtonVariant, CardGroupProps, CardLogo, CardProps };
export {
  Card,
  CardAction,
  CardButton,
  CardContent,
  CardDescription,
  CardEyebrow,
  CardFeature,
  CardFooter,
  CardGroup,
  CardHeader,
  CardImage,
  CardMedia,
  CardTitle,
};
