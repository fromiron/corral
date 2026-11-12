import type { PresenceTone } from '@corral/react';
import type { KitBadge } from '@corral/react/design-kit';
import type { ComponentProps } from 'react';

type BadgeColor = NonNullable<ComponentProps<typeof KitBadge>['color']>;

// The tone decides a state's colour wherever it shows: dot, mark or badge
// (docs/specs/features/presence.md). Each map below keeps StatusDot's colour for that tone.

// StatusDot takes a status word and colours it by that word's tone. A presence result already
// carries its tone, so each tone passes the one word that StatusDot draws in that tone.
const DOT: Record<PresenceTone, string> = {
  neutral: 'neutral',
  active: 'active',
  success: 'succeeded',
  warning: 'awaiting_user',
  danger: 'failed',
};

export function presenceDot(tone: PresenceTone) {
  return DOT[tone];
}

/** The text colour a kit mark drawn in `currentColor` takes for a tone: StatusDot's colours. */
const TEXT: Record<PresenceTone, string> = {
  neutral: 'text-muted-foreground/60',
  active: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

export function presenceToneText(tone: PresenceTone) {
  return TEXT[tone];
}

/** A badge's tint for a tone, as StatusBadge tints it. */
const BADGE: Record<PresenceTone, BadgeColor> = {
  neutral: 'gray',
  active: 'gray',
  success: 'green',
  warning: 'amber',
  danger: 'red',
};

export function presenceBadgeColor(tone: PresenceTone) {
  return BADGE[tone];
}
