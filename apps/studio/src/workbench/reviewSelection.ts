import type { SelectedLineRange } from '@pierre/diffs';

/** A review quote belongs to one side of an immutable comparison, never a mixed selection. */
export function reviewSelection(range: SelectedLineRange, before: string, after: string) {
  const side = range.side ?? 'additions';
  if (range.endSide && range.endSide !== side) return null;
  const startLine = Math.min(range.start, range.end);
  const endLine = Math.max(range.start, range.end);
  const lines = (side === 'deletions' ? before : after).split('\n');
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine > lines.length
  )
    return null;
  return {
    side: side === 'deletions' ? ('before' as const) : ('after' as const),
    startLine,
    endLine,
    quote: lines.slice(startLine - 1, endLine).join('\n'),
  };
}
