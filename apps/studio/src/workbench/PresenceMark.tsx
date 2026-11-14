import { type Presence, presenceTextClass } from '@corral/react';
import { AgentStatusIcon, cn } from '@corral/react/design-kit';
import { useTranslations } from 'use-intl';

/**
 * A state as the kit's mark alone: its shape from the glyph, its colour from the tone, and its
 * name for assistive technology only. Where the body already says the state in words (sidebar
 * rows, the path's menus), this keeps the name to once a screen (docs/specs/features/presence.md).
 * The slot keeps its size without a mark, so a line never shifts with the state.
 */
export function PresenceMark({
  presence,
  name,
}: {
  presence: Presence | null | undefined;
  /** The accessible name when it says more than the state (its detail beside it). */
  name?: string;
}) {
  const t = useTranslations('Presence');
  const glyph = presence?.glyph;
  return (
    <span className="inline-flex size-3 shrink-0 items-center justify-center align-middle">
      {presence && glyph ? (
        <span
          role="img"
          aria-label={name ?? t(presence.labelKey)}
          // The shape alone cannot tell a pause from a cancel: hovering names it, as a dot did.
          title={name ?? t(presence.labelKey)}
          data-presence={presence.kind}
          className={cn('inline-flex', presenceTextClass(presence.tone))}
        >
          <AgentStatusIcon status={glyph} size={12} colored={false} />
        </span>
      ) : null}
    </span>
  );
}
