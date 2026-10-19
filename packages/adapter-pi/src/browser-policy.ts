import type { LocalBrowserRecipe } from '@corral/contracts';

export const BROWSER_TOOLS = new Set([
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_select_option',
  'browser_press_key',
  'browser_hover',
  'browser_resize',
  'browser_wait_for',
  'browser_close',
  'browser_take_screenshot',
  'browser_verify_element_visible',
  'browser_verify_text_visible',
  'browser_verify_list_visible',
  'browser_verify_value',
]);

export function assertBrowserCall(
  recipe: Pick<LocalBrowserRecipe, 'origin'>,
  name: string,
  args: Record<string, unknown>,
) {
  if (!BROWSER_TOOLS.has(name)) throw new Error('tool is not available in the owned local browser');
  if ('filename' in args || 'paths' in args || 'time' in args)
    throw new Error('browser file output and timed waits are not caller controlled');
  if (name === 'browser_navigate') {
    const url = new URL(String(args.url));
    if (url.origin !== recipe.origin || url.username || url.password)
      throw new Error('browser navigation is outside the local fixture');
  }
}
