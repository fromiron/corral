// Motion tokens. Each tier is the ENTER spring; its `.exit` is a quicker,
// bounce-free tween so dismissals read as crisp rather than a reversed entrance.
//
//   transition={spring.fast}                              // enter
//   exit={{ opacity: 0, transition: spring.fast.exit }}   // leave
//
// The bigger the thing that moves, the slower the tier. Never hand-write a
// duration.
export const spring = {
  fast: {
    type: 'spring' as const,
    duration: 0.08,
    bounce: 0,
    exit: { duration: 0.06 },
  },
  // No overshoot — for things that must settle precisely (dropdowns, tabs,
  // drawers, merged selection backgrounds).
  moderate: {
    type: 'spring' as const,
    duration: 0.16,
    bounce: 0,
    exit: { duration: 0.12 },
  },
  slow: {
    type: 'spring' as const,
    duration: 0.24,
    bounce: 0.12,
    exit: { duration: 0.16 },
  },
} as const;

// Fallback (ms) for timers that force-unmount a popup after its exit tween,
// in case a throttled background tab never fires onAnimationComplete.
export const exitFallbackMs = (tier: { exit: { duration: number } }) =>
  Math.round(tier.exit.duration * 1000) + 100;
