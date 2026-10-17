export function externalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function trustedSender(
  url: string,
  origin: string | null,
  startup: string,
  mainFrame: boolean,
) {
  if (!mainFrame) return false;
  if (url === startup) return true;
  try {
    return !!origin && new URL(url).origin === origin;
  } catch {
    return false;
  }
}

export function localRoute(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\')
  )
    return '/';
  try {
    const url = new URL(value, 'http://corral.local');
    return url.origin === 'http://corral.local' ? `${url.pathname}${url.search}` : '/';
  } catch {
    return '/';
  }
}
