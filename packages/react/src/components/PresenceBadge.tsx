import { useCallback } from 'react';
import { useTranslations } from 'use-intl';
import { AgentStatusIcon, cn, KitBadge, useSize } from '../design-kit/index.ts';
import type { Presence, PresenceTone } from '../run/presence.ts';
import { statusPresence } from '../run/projectionPresence.ts';

// The colour of a state comes from its tone alone, wherever it shows: dot, mark or badge
// (docs/specs/features/presence.md). The kit glyph gives only the shape.

const DOT: Record<PresenceTone, string> = {
  neutral: 'bg-muted-foreground/60',
  active: 'bg-primary animate-pulse',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

const TEXT: Record<PresenceTone, string> = {
  neutral: 'text-muted-foreground/60',
  active: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

const BADGE = {
  neutral: 'gray',
  active: 'gray',
  success: 'green',
  warning: 'amber',
  danger: 'red',
} as const satisfies Record<PresenceTone, string>;

/** The dot's background class for a tone. */
export function presenceDotClass(tone: PresenceTone) {
  return DOT[tone];
}

/** The text colour a mark drawn in `currentColor` takes for a tone: the dot's colour. */
export function presenceTextClass(tone: PresenceTone) {
  return TEXT[tone];
}

/** A badge's tint for a tone. */
export function presenceBadgeColor(tone: PresenceTone) {
  return BADGE[tone];
}

/** What a state name says: a Run or an execution (`data-presence-label`). */
export type PresenceTarget = `run:${string}` | `execution:${string}`;

/**
 * A state as a badge with its name: the kit's AgentStatusBadge shape, tinted by the tone. With a
 * `target` the name is the one place that target's state is said in words.
 */
export function PresenceBadge({
  presence,
  target,
}: {
  presence: Presence;
  target?: PresenceTarget;
}) {
  const t = useTranslations('Presence');
  return (
    <KitBadge color={presenceBadgeColor(presence.tone)} data-presence={presence.kind}>
      <span className="inline-flex items-center gap-1">
        {presence.glyph ? (
          <span className={cn('inline-flex', presenceTextClass(presence.tone))}>
            <AgentStatusIcon status={presence.glyph} size={11} colored={false} />
          </span>
        ) : null}
        <span data-presence-label={target}>{t(presence.labelKey)}</span>
      </span>
    </KitBadge>
  );
}

/** A state as a dot; with `label` it carries the state's name for assistive technology. */
export function PresenceDot({ presence, label }: { presence: Presence; label?: boolean }) {
  const t = useTranslations('Presence');
  const className = cn(
    'inline-block size-2 shrink-0 rounded-full',
    presenceDotClass(presence.tone),
  );
  return label ? (
    <span
      role="img"
      aria-label={t(presence.labelKey)}
      title={t(presence.labelKey)}
      data-presence={presence.kind}
      className={className}
    />
  ) : (
    <span aria-hidden="true" data-presence={presence.kind} className={className} />
  );
}

/**
 * A state as a glyph and its name in caption text: the kit's AgentStatusLabel shape, the glyph in
 * the tone's colour. With a `target` the name is the one place that target's state is in words.
 */
export function PresenceLabel({
  presence,
  target,
  className,
}: {
  presence: Presence;
  target?: PresenceTarget;
  className?: string;
}) {
  const t = useTranslations('Presence');
  const size = useSize();
  return (
    <span
      data-presence={presence.kind}
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 text-muted-foreground',
        size.type.caption,
        className,
      )}
    >
      {presence.glyph ? (
        <span className={cn('inline-flex shrink-0', presenceTextClass(presence.tone))}>
          <AgentStatusIcon
            status={presence.glyph}
            size={size.variant === 'compact' ? 11 : 12}
            colored={false}
          />
        </span>
      ) : null}
      <span className="truncate">
        <span data-presence-label={target}>{t(presence.labelKey)}</span>
        {/* A detail is the activity beside the state, never its name (presence.md). */}
        {presence.detailKey ? ` · ${t(presence.detailKey)}` : null}
      </span>
    </span>
  );
}

/**
 * The name of a bare Run or execution status in presence words, for a place that holds only the
 * status (a list row, a search hit, a notification), with its detail beside it. Anything else
 * is returned as it came.
 */
export function usePresenceWord(): (status: string) => string {
  const t = useTranslations('Presence');
  return useCallback(
    (status: string) => {
      const presence = statusPresence(status);
      if (!presence) return status;
      // A detail is said beside the state, never instead of it.
      return presence.detailKey
        ? `${t(presence.labelKey)} · ${t(presence.detailKey)}`
        : t(presence.labelKey);
    },
    [t],
  );
}
