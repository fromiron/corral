import type { AnnotateContext } from './protocol.ts';

/**
 * Draws the overlay in the app page's appearance and language: the base's scope class and
 * `color-scheme` (as the app's applyTheme does) and a named theme's tokens on the root. Only
 * custom properties are applied; the ones a previous context set and this one lacks are removed.
 * Returns the names now set, for the next call.
 */
export function applyContext(
  root: HTMLElement,
  context: Pick<AnnotateContext, 'locale' | 'theme'>,
  previous: ReadonlySet<string>,
): Set<string> {
  const { dark, tokens } = context.theme;
  root.lang = context.locale;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.classList.toggle('dark', dark);
  root.classList.toggle('light', !dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  const next = new Set<string>();
  for (const [name, value] of Object.entries(tokens ?? {})) {
    if (!/^--[a-z0-9-]{1,64}$/.test(name) || typeof value !== 'string') continue;
    root.style.setProperty(name, value);
    next.add(name);
  }
  for (const name of previous) if (!next.has(name)) root.style.removeProperty(name);
  return next;
}
