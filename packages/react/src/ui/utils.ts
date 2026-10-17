import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// The theme's extra type steps (theme.css) are font sizes, not colors; without this a
// `text-ui text-muted` pair would lose one of the two.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ['2xs', 'ui', 'reader'] } } });

export function cn(...values: ClassValue[]) {
  return twMerge(clsx(values));
}
