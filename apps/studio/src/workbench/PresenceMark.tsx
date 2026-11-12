import type { Presence } from '@corral/react';
import { AgentStatusIcon, cn, KitBadge } from '@corral/react/design-kit';
import type { ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { presenceBadgeColor, presenceToneText } from './presenceDot.ts';

/**
 * A state as the kit's mark alone: its shape from the glyph, its colour from the tone, and its
 * name for assistive technology only. Where the body already says the state in words (sidebar
 * rows, the path's menus), this keeps the name to once a screen (docs/specs/features/presence.md).
 * The slot keeps its size without a mark, so a line never shifts with the state.
 */
export function PresenceMark({ presence }: { presence: Presence | null | undefined }) {
  const t = useTranslations('Presence');
  const glyph = presence?.glyph;
  return (
    <span className="inline-flex size-3 shrink-0 items-center justify-center align-middle">
      {presence && glyph ? (
        <span
          role="img"
          aria-label={t(presence.labelKey)}
          data-presence={presence.kind}
          className={cn('inline-flex', presenceToneText(presence.tone))}
        >
          <AgentStatusIcon status={glyph} size={12} colored={false} />
        </span>
      ) : null}
    </span>
  );
}

/**
 * A state as a badge with its name, the kit's AgentStatusBadge look tinted by the tone instead of
 * the glyph's own colour. `target` names what the words say: `run:<runId>`.
 */
export function PresenceBadge({
  presence,
  target,
}: {
  presence: Presence;
  target: `run:${string}` | `execution:${string}`;
}): ReactNode {
  const t = useTranslations('Presence');
  return (
    <KitBadge color={presenceBadgeColor(presence.tone)} data-presence={presence.kind}>
      <span className="inline-flex items-center gap-1">
        {presence.glyph ? (
          <span className={cn('inline-flex', presenceToneText(presence.tone))}>
            <AgentStatusIcon status={presence.glyph} size={11} colored={false} />
          </span>
        ) : null}
        <span data-presence-label={target}>{t(presence.labelKey)}</span>
      </span>
    </KitBadge>
  );
}
