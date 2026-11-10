// One treatment for the chosen row of a list or table (DESIGN.md, "Layout, Spacing and Shape"):
// the fill of the sidebar's active row, the kit's --active overlay, with the row's own radius.
// Hover keeps the lighter --hover overlay and keyboard focus its ring, so the three stay apart.
// Button fills (secondary) are not used for rows.

/** A list row drawn as a ghost Button (the settings lists): the fill on the row itself. */
export const CHOSEN_BUTTON_ROW = 'bg-active text-foreground';

/**
 * A kit Table row: the fill sits on its cells, square like the table's own hover highlight, and
 * the row drops its rule so the fill reads as one piece.
 */
export const CHOSEN_TABLE_ROW = 'border-transparent [&>td]:bg-active [&>td]:text-foreground';

/** The row above a chosen table row (or the header, above the first) drops its rule too. */
export const ABOVE_CHOSEN_TABLE_ROW = 'border-transparent';
