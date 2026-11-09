import { Button } from '@corral/react/design-kit';
import { ArrowDown, ArrowUp } from '@corral/react/icons';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { REVIEW_MOVE_KEYS, reveal, stepIndex } from './reviewNavigation.ts';

/** Moves to the next (1) or previous (-1) change; false at either end. */
export interface HunkNavigation {
  move(direction: 1 | -1): boolean;
}

/**
 * The changes of one diff, one at a time: previous/next buttons and the current change's header,
 * which takes focus on every move. `onReveal` scrolls the diff to that change.
 */
export function HunkNavigator({
  hunks,
  onReveal,
  navigation,
}: {
  hunks: readonly { label: string }[];
  onReveal(index: number): void;
  navigation?: RefObject<HunkNavigation | null> | undefined;
}) {
  const t = useTranslations('Review');
  const [index, setIndex] = useState<number | null>(null);
  const header = useRef<HTMLParagraphElement>(null);
  const moved = useRef(false);
  const latest = useRef({ index, count: hunks.length, onReveal });
  latest.current = { index, count: hunks.length, onReveal };
  const move = useRef((direction: 1 | -1) => {
    const { index, count, onReveal } = latest.current;
    const next = stepIndex(index, count, direction);
    if (next === null) return false;
    latest.current.index = next;
    moved.current = true;
    setIndex(next);
    onReveal(next);
    return true;
  }).current;
  useEffect(() => {
    if (!navigation) return;
    const handle = { move };
    navigation.current = handle;
    return () => {
      if (navigation.current === handle) navigation.current = null;
    };
  }, [navigation, move]);
  useEffect(() => {
    if (index === null || !moved.current) return;
    moved.current = false;
    header.current?.focus({ preventScroll: true });
    reveal(header.current);
  }, [index]);
  const current = index === null ? undefined : hunks[index];
  return (
    <div className="flex min-w-0 items-center gap-1 text-caption">
      <Button
        variant="ghost"
        size="icon-compact"
        aria-label={t('previousChange')}
        title={`${t('previousChange')} (${REVIEW_MOVE_KEYS.previousChange})`}
        aria-keyshortcuts={REVIEW_MOVE_KEYS.previousChange}
        disabled={hunks.length === 0 || index === 0}
        onClick={() => move(-1)}
      >
        <ArrowUp aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon-compact"
        aria-label={t('nextChange')}
        title={`${t('nextChange')} (${REVIEW_MOVE_KEYS.nextChange})`}
        aria-keyshortcuts={REVIEW_MOVE_KEYS.nextChange}
        disabled={hunks.length === 0 || index === hunks.length - 1}
        onClick={() => move(1)}
      >
        <ArrowDown aria-hidden />
      </Button>
      <p
        ref={header}
        tabIndex={-1}
        data-testid="hunk-header"
        className="min-w-0 truncate rounded-sm px-1 text-muted-foreground"
      >
        {current && index !== null ? (
          <>
            <span className="text-foreground">
              {t('changePosition', { index: index + 1, count: hunks.length })}
            </span>{' '}
            <span className="font-mono">{current.label}</span>
          </>
        ) : (
          t('changeCount', { count: hunks.length })
        )}
      </p>
    </div>
  );
}
