import { Button, Tooltip } from '@corral/react/design-kit';
import { ArrowDown, ArrowUp } from '@corral/react/icons';
import type { Hunk } from '@pierre/diffs';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { REVIEW_MOVE_KEYS, reveal, stepIndex } from './reviewNavigation.ts';

/** Moves to the next (1) or previous (-1) change; false at either end. */
export interface HunkNavigation {
  move(direction: 1 | -1): boolean;
}

/** A hunk header as Git writes it, with the enclosing function when the diff names one. */
export const hunkLabel = (hunk: Hunk) =>
  [
    hunk.hunkSpecs ??
      `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`,
    hunk.hunkContext,
  ]
    .filter(Boolean)
    .join(' ');

/**
 * The changes of one diff, one at a time: the position ("1 / 3"), which takes focus on every
 * move and reads out the change's header, and previous/next buttons. `onReveal` scrolls the
 * diff to that change.
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
    <div className="flex shrink-0 items-center gap-0.5 text-caption">
      <p
        ref={header}
        tabIndex={-1}
        data-testid="hunk-header"
        title={current?.label}
        className="rounded-sm px-1 whitespace-nowrap text-muted-foreground tabular-nums"
      >
        {current && index !== null ? (
          <>
            <span aria-hidden className="text-foreground">
              {index + 1} / {hunks.length}
            </span>
            <span className="sr-only">
              {t('changePosition', { index: index + 1, count: hunks.length })} {current.label}
            </span>
          </>
        ) : (
          t('changeCount', { count: hunks.length })
        )}
      </p>
      <Tooltip content={t('previousChange')} shortcut={REVIEW_MOVE_KEYS.previousChange}>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('previousChange')}
          aria-keyshortcuts={REVIEW_MOVE_KEYS.previousChange}
          disabled={hunks.length === 0 || index === 0}
          onClick={() => move(-1)}
        >
          <ArrowUp aria-hidden />
        </Button>
      </Tooltip>
      <Tooltip content={t('nextChange')} shortcut={REVIEW_MOVE_KEYS.nextChange}>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('nextChange')}
          aria-keyshortcuts={REVIEW_MOVE_KEYS.nextChange}
          disabled={hunks.length === 0 || index === hunks.length - 1}
          onClick={() => move(1)}
        >
          <ArrowDown aria-hidden />
        </Button>
      </Tooltip>
    </div>
  );
}
