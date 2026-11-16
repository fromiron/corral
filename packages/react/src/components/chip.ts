import { focusRing } from '../design-kit/lib/focus.ts';

/**
 * The composer's small chip control (features/composer-flow.md "활동 바"): no border and no fill
 * at rest, as tall as a compact control, caption text in the muted tone that turns to the
 * foreground on hover. The Overview opener, the context pill and the Reins controls share it.
 */
export const chipClass = `inline-flex min-h-7 pointer-coarse:min-h-11 min-w-0 max-w-full items-center gap-1.5 rounded-full px-2.5 text-caption text-muted-foreground transition-colors hover:bg-subtle hover:text-foreground ${focusRing}`;
