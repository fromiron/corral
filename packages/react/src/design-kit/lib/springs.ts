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

// Tweens, for the few motions a spring can't express: a fixed-length fade
// on a layer that must finish exactly (crossfades, height collapses driven
// by a measured value, SVG path draws). Same three speeds as the springs.
const easeOutSoft = [0.23, 1, 0.32, 1] as const;
export const tween = {
  fast: { type: 'tween' as const, duration: 0.08, ease: easeOutSoft, exit: { duration: 0.06 } },
  moderate: { type: 'tween' as const, duration: 0.16, ease: easeOutSoft, exit: { duration: 0.12 } },
  slow: { type: 'tween' as const, duration: 0.24, ease: easeOutSoft, exit: { duration: 0.16 } },
} as const;

// Loops: ambient motion for live things (a breathing dot, a running bar).
// Spread into a Motion `transition`; pair each with a reduced-motion check
// (useReducedMotion) that renders the resting state instead. CSS loops for
// the same jobs live in tokens.css: .shimmer-text, .sheen, .flow-dash,
// .pulse-soft.
export const loop = {
  pulse: { duration: 1.8, ease: 'easeInOut' as const, repeat: Infinity },
  breathe: { duration: 2.4, ease: 'easeInOut' as const, repeat: Infinity },
  spin: { duration: 0.9, ease: 'linear' as const, repeat: Infinity },
  ping: { duration: 1.6, ease: easeOutSoft, repeat: Infinity, repeatDelay: 0.6 },
} as const;

/** CSS-transition tiers as literal Tailwind classes (pairs with the springs). */
export const transitionClass = {
  fast: 'duration-80',
  moderate: 'duration-160',
  slow: 'duration-240',
} as const;
