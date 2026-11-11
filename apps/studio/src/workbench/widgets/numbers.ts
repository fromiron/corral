/**
 * A count on screen. Korean writes numbers in full with grouping (2,400, not 2.4천; DESIGN.md
 * Typography); other locales keep the short form each place already uses, given as `short`.
 */
export function formatCount(
  value: number,
  locale: string,
  short: (value: number) => string,
): string {
  return locale.toLowerCase().startsWith('ko')
    ? new Intl.NumberFormat(locale).format(value)
    : short(value);
}
