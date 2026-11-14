'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { forwardRef, type HTMLAttributes, useEffect, useState } from 'react';
import { fontWeights } from '../../lib/font-weight.ts';
import { type SizeVariant, typeClass, useSize } from '../../lib/size-context.tsx';
import { loop, tween } from '../../lib/springs.ts';
import { cn } from '../../lib/utils.ts';

// One path morphing circle ⇄ infinity. All shapes share the same commands so
// the morph interpolates point for point; circleA and circleB run in opposite
// directions so each pass keeps flowing the same way instead of unwinding.
const circleA =
  'M 12 8 C 14.21 8 16 9.79 16 12 C 16 14.21 14.21 16 12 16 C 9.79 16 8 14.21 8 12 C 8 9.79 9.79 8 12 8 Z';

const infinity =
  'M 12 12 C 14 8.5 19 8.5 19 12 C 19 15.5 14 15.5 12 12 C 10 8.5 5 8.5 5 12 C 5 15.5 10 15.5 12 12 Z';

const circleB =
  'M 12 16 C 14.21 16 16 14.21 16 12 C 16 9.79 14.21 8 12 8 C 9.79 8 8 9.79 8 12 C 8 14.21 9.79 16 12 16 Z';

interface ThinkingIndicatorLabels {
  /** The static screen-reader announcement. */
  status: string;
  /** The visible words that roll in turn; must not be empty. */
  words: readonly string[];
}

const defaultLabels: ThinkingIndicatorLabels = {
  status: 'Thinking…',
  words: ['Thinking', 'Moonwalking', 'Planning', 'Refining'],
};

interface ThinkingIndicatorProps extends HTMLAttributes<HTMLDivElement> {
  /** Show the morphing circle⇄infinity glyph before the label. Set to `false`
   *  for a text-only indicator (e.g. inline before a streamed reply). */
  showIcon?: boolean;
  /** Step on the size ladder. Wins over the surrounding SizeProvider. */
  size?: SizeVariant;
  /** Localized announcement and words; the source English is the default. */
  labels?: Partial<ThinkingIndicatorLabels>;
}

const ThinkingIndicator = forwardRef<HTMLDivElement, ThinkingIndicatorProps>(
  ({ className, showIcon = true, size, labels, ...props }, ref) => {
    const status = labels?.status ?? defaultLabels.status;
    const words = labels?.words?.length ? labels.words : defaultLabels.words;
    const compactStep = useSize(size).variant === 'compact';
    const [index, setIndex] = useState(0);
    // Reduced motion drops the glyph morph and word cycling.
    const reduceMotion = useReducedMotion() ?? false;

    useEffect(() => {
      if (reduceMotion) return;
      const interval = setInterval(() => {
        setIndex((i) => (i + 1) % words.length);
      }, 4000);
      return () => clearInterval(interval);
    }, [reduceMotion, words.length]);
    // A shorter host word list keeps the index in range.
    const word = words[index % words.length];

    return (
      <div
        ref={ref}
        role="status"
        className={cn('flex items-center gap-2 px-3 py-2', className)}
        {...props}
      >
        {/* Static announcement; the cycling words are aria-hidden so screen
          readers don't re-announce every 4 seconds. */}
        <span className="sr-only">{status}</span>
        {showIcon && (
          <motion.svg
            aria-hidden
            width={compactStep ? 18 : 20}
            height={compactStep ? 18 : 20}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-muted-foreground shrink-0"
          >
            {reduceMotion ? (
              <path d={infinity} />
            ) : (
              <motion.path
                d={circleA}
                initial={{ d: circleA }}
                animate={{
                  d: [circleA, infinity, circleB, infinity, circleA],
                }}
                transition={{
                  // The breathe loop's ease and repeat, stretched to the morph's 6s cycle.
                  d: {
                    ...loop.breathe,
                    duration: 6,
                    times: [0, 0.25, 0.5, 0.75, 1.0],
                  },
                }}
              />
            )}
          </motion.svg>
        )}
        {/* Words share one grid cell; overflow-hidden clips them as they roll. */}
        <span
          aria-hidden="true"
          className={cn(
            'inline-grid overflow-hidden',
            typeClass('body', compactStep ? 'compact' : 'default'),
          )}
          style={{ fontVariationSettings: fontWeights.normal }}
        >
          {/* An invisible copy of the longest word reserves the width.
            `shimmer-text` is defined in this component's CSS. */}
          <span className="col-start-1 row-start-1 invisible shimmer-text">
            {words.reduce((a, b) => (a.length >= b.length ? a : b))}
          </span>
          {reduceMotion ? (
            <span className="col-start-1 row-start-1 shimmer-text">{words[0]}</span>
          ) : (
            // popLayout lets the outgoing word leave layout at once so both
            // overlap; the faster exit clears it before the new one lands.
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={word}
                className="col-start-1 row-start-1 shimmer-text"
                initial={{ y: '80%', opacity: 0 }}
                animate={{ y: 0, opacity: 1, transition: tween.slow }}
                exit={{ y: '-80%', opacity: 0, transition: tween.slow.exit }}
              >
                {word}
              </motion.span>
            </AnimatePresence>
          )}
        </span>
      </div>
    );
  },
);

ThinkingIndicator.displayName = 'ThinkingIndicator';

export type { ThinkingIndicatorLabels, ThinkingIndicatorProps };
export { ThinkingIndicator };
export default ThinkingIndicator;
