// Where a terminal opens (features/session-panel.md 여는 길, 주소와 기억, "+" 목록). A terminal's
// tab is in the panel or in the bottom dock, never both; no opening way moves it to the other
// strip. Plain data only: the page reads the strips and the terminal list and does what this says.

/** What the conversation's terminal list has said since the entry. */
export type TerminalListAnswer =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'failed' }
  | {
      readonly kind: 'answered';
      /** Every terminal it lists. */
      readonly ids: readonly string[];
      /** The live one (one per Paddock), if any. */
      readonly live: string | null;
    };

/** The terminals that have a tab in each strip. */
export interface TerminalStrips {
  readonly panel: ReadonlySet<string>;
  readonly dock: ReadonlySet<string>;
}

/**
 * `panel` / `dock`: open or select that terminal's tab there (the dock opens with it).
 * `create`: make a terminal with the default shell and open its tab in the dock. `dockOnly`: open
 * the dock and nothing in it (its body says why). `wait`: decide once the list answers. `none`:
 * open nothing.
 */
export type AddressedPlace =
  | { readonly place: 'panel' | 'dock'; readonly terminalId: string }
  | { readonly place: 'create' | 'dockOnly' | 'wait' | 'none' };

const where = (terminalId: string, strips: TerminalStrips): 'panel' | 'dock' | null =>
  strips.panel.has(terminalId) ? 'panel' : strips.dock.has(terminalId) ? 'dock' : null;

/**
 * `panel=terminal`, with or without `terminal`. `creatable`: a terminal can be made now (the
 * same answer the "+" list's 터미널 reads).
 */
export function addressedTerminalPlace(
  terminalId: string | undefined,
  strips: TerminalStrips,
  list: TerminalListAnswer,
  creatable: boolean,
): AddressedPlace {
  if (terminalId) {
    const strip = where(terminalId, strips);
    if (strip) return { place: strip, terminalId };
    if (list.kind === 'waiting') return { place: 'wait' };
    // An unreadable list keeps the address, as a run tab's does.
    if (list.kind === 'failed' || list.ids.includes(terminalId))
      return { place: 'dock', terminalId };
    return { place: 'none' };
  }
  if (list.kind === 'waiting') return { place: 'wait' };
  if (list.kind === 'failed') return { place: 'dockOnly' };
  if (list.live) return { place: where(list.live, strips) ?? 'dock', terminalId: list.live };
  return { place: creatable ? 'create' : 'dockOnly' };
}

export type PlusPlace =
  | { readonly place: 'panel' | 'dock'; readonly terminalId: string }
  | { readonly place: 'create'; readonly strip: 'panel' | 'dock' }
  | { readonly place: 'none' };

/**
 * "+" → 터미널 in the panel's or the dock's list: the live terminal's tab where it is, else in the
 * strip of the list; a new terminal there only when none is live; nothing when none can be made.
 */
export function plusTerminalPlace(
  from: 'panel' | 'dock',
  live: string | null,
  strips: TerminalStrips,
  creatable: boolean,
): PlusPlace {
  if (live) return { place: where(live, strips) ?? from, terminalId: live };
  return creatable ? { place: 'create', strip: from } : { place: 'none' };
}
