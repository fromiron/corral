import { type ClassValue, clsx } from 'clsx';
import type { Ref } from 'react';
import { extendTailwindMerge } from 'tailwind-merge';

// The type-scale role utilities are font sizes, but tailwind-merge treats an
// unknown text-<word> as a text *color*, so cn("text-body",
// "text-muted-foreground") would silently drop the size.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        'text-2xs',
        'text-ui',
        'text-reader',
        'text-display',
        'text-title',
        'text-subtitle',
        'text-body',
        'text-caption',
        'text-micro',
        'text-site-display',
        'text-site-title',
        'text-site-subtitle',
        'text-site-body',
        'text-site-caption',
        'text-site-micro',
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Points a ref (callback or object) at `value`; for merging a forwarded ref
 *  with a local one. */
export function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}
