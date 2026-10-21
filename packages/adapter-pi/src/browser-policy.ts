import { LocalBrowserRecipe, RegisteredMcpServer } from '@corral/contracts';
import { z } from 'zod';

/** Private host-to-launcher data; never accepted from project MCP configuration. */
export const PreviewBrowserTarget = z
  .strictObject({
    url: z.string().max(4096),
    origin: z.string().regex(/^http:\/\/127\.0\.0\.2:[1-9][0-9]{3,4}$/),
    webSocketOrigins: z.array(z.string()).max(1),
    headers: z.strictObject({ 'x-corral-preview': z.string().min(16).max(256) }),
    pathPrefix: z.string().startsWith('/').max(512).optional(),
  })
  .superRefine((target, ctx) => {
    try {
      assertOwnedBrowserOrigin(target.url, target);
      if (
        target.webSocketOrigins.some((origin) => origin !== target.origin.replace('http:', 'ws:'))
      )
        throw new Error('unowned websocket');
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid owned preview target' });
    }
  });
export type PreviewBrowserTarget = {
  url: string;
  origin: string;
  webSocketOrigins: string[];
  headers: Record<string, string>;
  pathPrefix?: string;
};

export const OwnedBrowserLaunch = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fixture'), server: RegisteredMcpServer }),
  z.strictObject({
    kind: z.literal('preview'),
    target: PreviewBrowserTarget,
    executablePath: LocalBrowserRecipe.shape.executablePath,
    timeoutMs: z.int().min(1000).max(300000),
  }),
]);

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

/** The owner must establish these origins from a live lease, never from tool arguments. */
export function assertOwnedBrowserOrigin(
  value: string,
  policy: { origin: string; pathPrefix?: string; webSocketOrigins?: readonly string[] },
  kind: 'http' | 'websocket' = 'http',
): URL {
  const url = new URL(value);
  const allowed =
    kind === 'websocket'
      ? (url.protocol === 'ws:' || url.protocol === 'wss:') &&
        policy.webSocketOrigins?.includes(url.origin)
      : (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === policy.origin;
  if (!allowed || url.username || url.password)
    throw new Error('browser request is outside the owned origin');
  if (policy.pathPrefix) {
    const prefix = policy.pathPrefix.endsWith('/') ? policy.pathPrefix : `${policy.pathPrefix}/`;
    if (!url.pathname.startsWith(prefix))
      throw new Error('browser request is outside the owned path');
  }
  return url;
}

export function assertBrowserCall(
  recipe: Pick<LocalBrowserRecipe, 'origin'> & { pathPrefix?: string },
  name: string,
  args: Record<string, unknown>,
) {
  if (!BROWSER_TOOLS.has(name)) throw new Error('tool is not available in the owned local browser');
  if ('filename' in args || 'paths' in args || 'time' in args)
    throw new Error('browser file output and timed waits are not caller controlled');
  if (name === 'browser_navigate') assertOwnedBrowserOrigin(String(args.url), recipe);
}
