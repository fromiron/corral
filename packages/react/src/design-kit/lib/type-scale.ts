// Six-role type scale: a font size and line height per role, per size step.
// Keep in sync with the --fs-* / --lh-* CSS variables and text-<role> tokens.

type TypeScaleVariant = 'default' | 'compact';

/** One role at one ladder step, in px. */
interface TypeScalePair {
  size: number;
  leading: number;
}

/** One role's font size at each ladder step, in px. */
interface TypeScaleStep {
  default: number;
  compact: number;
}

const typeStyles = {
  /** Page titles. */
  display: {
    default: { size: 28, leading: 34 },
    compact: { size: 24, leading: 30 },
  },
  /** Section headings, dialog titles. */
  title: {
    default: { size: 16, leading: 22 },
    compact: { size: 15, leading: 20 },
  },
  /** Card titles, chat bubbles, emphasized rows. */
  subtitle: {
    default: { size: 14, leading: 20 },
    compact: { size: 13, leading: 18 },
  },
  /** Control labels and body copy. The 20px leading makes a padded row 36px
   *  (8 + 20 + 8); 18px makes 28px in compact. */
  body: {
    default: { size: 13, leading: 20 },
    compact: { size: 12, leading: 18 },
  },
  /** Secondary text: descriptions, meta rows, errors, group labels. */
  caption: {
    default: { size: 12, leading: 16 },
    compact: { size: 11, leading: 14 },
  },
  /** Keyboard caps, counters, tiny badges. Single line only. */
  micro: {
    default: { size: 11, leading: 14 },
    compact: { size: 10, leading: 12 },
  },
} as const satisfies Record<string, Record<TypeScaleVariant, TypeScalePair>>;

type TypeScaleRole = keyof typeof typeStyles;

const typeScaleRoles = Object.keys(typeStyles) as TypeScaleRole[];

/** Font sizes alone, per role and step, in px. */
const typeScale = Object.fromEntries(
  typeScaleRoles.map((role) => [
    role,
    { default: typeStyles[role].default.size, compact: typeStyles[role].compact.size },
  ]),
) as Record<TypeScaleRole, TypeScaleStep>;

// Class strings per role and step. Arbitrary values over the CSS variables with
// px fallbacks, so they work without the type-scale tokens and tailwind-merge
// reads them as font sizes. Literal on purpose: Tailwind only emits classes it
// sees verbatim.
const typeClasses = {
  default: {
    display: 'text-[length:var(--fs-display,28px)] leading-[var(--lh-display,34px)]',
    title: 'text-[length:var(--fs-title,16px)] leading-[var(--lh-title,22px)]',
    subtitle: 'text-[length:var(--fs-subtitle,14px)] leading-[var(--lh-subtitle,20px)]',
    body: 'text-[length:var(--fs-body,13px)] leading-[var(--lh-body,20px)]',
    caption: 'text-[length:var(--fs-caption,12px)] leading-[var(--lh-caption,16px)]',
    micro: 'text-[length:var(--fs-micro,11px)] leading-[var(--lh-micro,14px)]',
  },
  compact: {
    display:
      'text-[length:var(--fs-display-compact,24px)] leading-[var(--lh-display-compact,30px)]',
    title: 'text-[length:var(--fs-title-compact,15px)] leading-[var(--lh-title-compact,20px)]',
    subtitle:
      'text-[length:var(--fs-subtitle-compact,13px)] leading-[var(--lh-subtitle-compact,18px)]',
    body: 'text-[length:var(--fs-body-compact,12px)] leading-[var(--lh-body-compact,18px)]',
    caption:
      'text-[length:var(--fs-caption-compact,11px)] leading-[var(--lh-caption-compact,14px)]',
    micro: 'text-[length:var(--fs-micro-compact,10px)] leading-[var(--lh-micro-compact,12px)]',
  },
} as const satisfies Record<TypeScaleVariant, Record<TypeScaleRole, string>>;

/** The class string for one role at one step (size + leading). */
function typeClass(role: TypeScaleRole, variant: TypeScaleVariant = 'default'): string {
  return typeClasses[variant][role];
}

/** Added after an editable field's role: 16px font size on touch screens, so
 *  iOS Safari doesn't zoom into the focused field. Leading is unchanged. */
const fieldTouchClass = 'pointer-coarse:text-[16px]';

export type { TypeScalePair, TypeScaleRole, TypeScaleStep, TypeScaleVariant };
export { fieldTouchClass, typeClass, typeClasses, typeScale, typeScaleRoles, typeStyles };
