// The kit's one focus indicator: a 2px --focus-ring outline, 2px outside the
// element. An outline follows border-radius and never fights a component's
// own box-shadows (press geometry, surface shadows), which a ring would.
//
//   <button className={cn(focusRing, ...)} />
//   <li className={focusRingInset} />   // rows inside a clipped scroller
//
// Don't pair either with `outline-none`: in Tailwind v4 that zeroes the
// outline style the focus state relies on.
export const focusRing =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-[color:var(--focus-ring)]';

/** Same ring drawn just inside the edge, for rows in overflow-hidden lists. */
export const focusRingInset =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--focus-ring)]';
