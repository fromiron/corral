// The diff renderer (@pierre/diffs) writes a few words of its own in English and takes no
// option for them: the hidden-lines count between changes, its "Expand all" and the missing
// final newline. Its other expand controls are icons with role=button and no name. After each
// render the viewer's shadow root gets the words and the names from the catalog.

export interface DiffLabels {
  unmodifiedLines: (count: number) => string;
  moreContext: string;
  expandAll: string;
  noNewline: string;
  /** Names of the icon-only controls that show the hidden lines above, below, or both. */
  expandUp: string;
  expandDown: string;
  expandBoth: string;
}

/** The renderer's own words (DiffHunksRenderer, createSeparator, createNoNewlineElement). */
const UNMODIFIED = /^(\d+) unmodified lines?$/;
const MORE_CONTEXT = 'More unchanged context may be available';

function relabel(element: Element, text: string) {
  if (element.textContent !== text) element.textContent = text;
}

function name(element: Element, label: string) {
  if (element.getAttribute('aria-label') !== label) element.setAttribute('aria-label', label);
}

/** Puts the catalog's words in place of the renderer's English ones; safe to run again. */
export function localizeDiffLabels(root: ParentNode, labels: DiffLabels) {
  for (const span of root.querySelectorAll('[data-unmodified-lines]')) {
    // A span relabelled before matches neither and stays as it is.
    const text = span.textContent ?? '';
    const count = UNMODIFIED.exec(text)?.[1];
    if (count !== undefined) relabel(span, labels.unmodifiedLines(Number(count)));
    else if (text === MORE_CONTEXT) relabel(span, labels.moreContext);
  }
  for (const button of root.querySelectorAll('[data-expand-all-button]'))
    relabel(button, labels.expandAll);
  // createExpandButton: an icon in a div, its direction in one data attribute.
  for (const button of root.querySelectorAll('[data-expand-button]:not([data-expand-all-button])'))
    name(
      button,
      button.hasAttribute('data-expand-up')
        ? labels.expandUp
        : button.hasAttribute('data-expand-down')
          ? labels.expandDown
          : labels.expandBoth,
    );
  for (const line of root.querySelectorAll('[data-no-newline] > span'))
    relabel(line, labels.noNewline);
}
