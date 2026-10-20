export interface DesktopPreviewTarget {
  url: string;
  origin: string;
  webSocketOrigins?: string[];
  headers: Record<string, string>;
  pathPrefix?: string;
}

export function validatePreviewTarget(value: unknown): DesktopPreviewTarget {
  if (!value || typeof value !== 'object') throw new Error('Preview is unavailable');
  const target = value as DesktopPreviewTarget;
  const origin = new URL(target.origin);
  const url = new URL(target.url);
  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.2' ||
    !origin.port ||
    origin.origin !== target.origin ||
    url.origin !== origin.origin ||
    url.username ||
    url.password ||
    !target.headers ||
    typeof target.headers !== 'object'
  )
    throw new Error('Invalid preview authority');
  for (const [name, content] of Object.entries(target.headers)) {
    if (
      name.toLowerCase() !== 'x-corral-preview' ||
      typeof content !== 'string' ||
      !content ||
      /[\r\n]/.test(content)
    )
      throw new Error('Invalid preview header');
  }
  if (
    target.pathPrefix &&
    (!target.pathPrefix.startsWith('/') || !url.pathname.startsWith(target.pathPrefix))
  )
    throw new Error('Invalid preview path');
  for (const entry of target.webSocketOrigins ?? []) {
    const ws = new URL(entry);
    if (
      ws.protocol !== 'ws:' ||
      ws.hostname !== origin.hostname ||
      ws.port !== origin.port ||
      ws.origin !== entry
    )
      throw new Error('Invalid preview socket');
  }
  return target;
}

export function previewRequestAllowed(
  target: DesktopPreviewTarget,
  raw: string,
  resourceType = '',
) {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return false;
    if (url.protocol === 'data:') return resourceType === 'image';
    if (url.protocol === 'blob:') return url.origin === target.origin && resourceType === 'image';
    const same =
      url.origin === target.origin ||
      (url.protocol === 'ws:' && (target.webSocketOrigins ?? []).includes(url.origin));
    return same && (!target.pathPrefix || url.pathname.startsWith(target.pathPrefix));
  } catch {
    return false;
  }
}
