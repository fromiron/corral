// The annotation overlay's own place (features/browser-annotate.md 계약: 주석 화면의 자리,
// decision 44): the studio's overlay entry served by `corral-overlay://overlay/` into one
// in-memory partition with no cookies of the app, no network and no `corralDesktop`.
import type { Session, WebPreferences } from 'electron';

export const OVERLAY_SCHEME = 'corral-overlay';
export const OVERLAY_ORIGIN = `${OVERLAY_SCHEME}://overlay`;
export const OVERLAY_URL = `${OVERLAY_ORIGIN}/annotate.html`;
/** The overlay views' partition: no `persist:`, so it lives in memory only. */
export const OVERLAY_PARTITION = 'corral-annotate';

/** Nothing leaves the overlay: its own files only, no fetch, no frames, no forms. */
export const OVERLAY_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.json': 'application/json',
};

/**
 * The studio file an overlay URL names, relative to the studio's build (`annotate.html` or
 * `assets/…`), and its type; null for anything else.
 */
export function overlayResource(raw: string): { path: string; type: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== `${OVERLAY_SCHEME}:` ||
    url.hostname !== 'overlay' ||
    url.port ||
    url.username ||
    url.password
  )
    return null;
  const path = url.pathname;
  if (path === '/annotate.html') return { path: 'annotate.html', type: TYPES['.html'] as string };
  const parts = path.split('/').slice(1);
  if (
    parts[0] !== 'assets' ||
    parts.length < 2 ||
    parts.length > 6 ||
    parts.some((part) => !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,159}$/.test(part) || part.includes('..'))
  )
    return null;
  const name = parts.at(-1) as string;
  const extension = name.slice(name.lastIndexOf('.'));
  const type = TYPES[extension];
  if (!type || extension === '.html') return null;
  return { path: parts.join('/'), type };
}

/** The response headers of every overlay file. */
export const OVERLAY_HEADERS: Record<string, string> = {
  'content-security-policy': OVERLAY_CSP,
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'cross-origin-resource-policy': 'same-origin',
};

/**
 * Sets the overlay partition's rules once: its files from `read` (relative to the studio's
 * build), every other request cancelled, no permission, device, download or spelling service.
 */
export function configureOverlaySession(
  session: Session,
  read: (path: string) => Uint8Array | null,
): void {
  session.protocol.handle(OVERLAY_SCHEME, (request) => {
    const resource = request.method === 'GET' ? overlayResource(request.url) : null;
    const body = resource ? read(resource.path) : null;
    if (!resource || !body) return new Response('', { status: 404, headers: OVERLAY_HEADERS });
    return new Response(body as unknown as BodyInit, {
      headers: { ...OVERLAY_HEADERS, 'content-type': resource.type },
    });
  });
  // The overlay draws the page's words; nothing it loads may reach the network.
  session.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !details.url.startsWith(`${OVERLAY_ORIGIN}/`) }),
  );
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.setSpellCheckerEnabled(false);
  session.on('will-download', (event) => event.preventDefault());
}

/** The overlay view: sandboxed, isolated, its preload the only way out. */
export function overlayPreferences(preload: string, zoomFactor: number): WebPreferences {
  return {
    preload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    webviewTag: false,
    safeDialogs: true,
    spellcheck: false,
    navigateOnDragDrop: false,
    zoomFactor,
  };
}

/** The overlay's calls (annotate-preload.cjs), each on `annotate:<name>`. */
export const ANNOTATE_CALLS = [
  'frame',
  'pick',
  'walk',
  'wheel',
  'tokens',
  'preview',
  'release',
  'submit',
  'cancel-submit',
  'tell',
  'end',
  'ended',
] as const;
export type AnnotateCall = (typeof ANNOTATE_CALLS)[number];

/** A JSON value of at most `max` bytes, as a fresh copy; throws otherwise. */
export function jsonWithin(value: unknown, max: number): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new Error('Invalid annotate message');
  }
  if (text === undefined || Buffer.byteLength(text) > max)
    throw new Error('Invalid annotate message');
  return JSON.parse(text);
}
