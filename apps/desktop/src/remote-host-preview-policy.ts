export interface RemoteLease {
  leaseId: string;
  sessionId: string;
  state: string;
  kind: string;
  origin: string;
  url: string;
}

/** Only the remote host's live, path-keyed static lease grants an iframe forward. */
export function publicRemotePreview(lease: RemoteLease, sessionId: string, raw: string): boolean {
  try {
    const url = new URL(raw);
    const entry = new URL(lease.url);
    const prefix = /^\/[A-Za-z0-9_-]{43}\//.exec(entry.pathname)?.[0];
    return (
      lease.sessionId === sessionId &&
      lease.state === 'ready' &&
      lease.kind === 'static' &&
      entry.protocol === 'http:' &&
      entry.hostname === '127.0.0.2' &&
      Number(entry.port) >= 1024 &&
      Number(entry.port) <= 65535 &&
      entry.origin === lease.origin &&
      url.origin === entry.origin &&
      !url.username &&
      !url.password &&
      Boolean(prefix && url.pathname.startsWith(prefix))
    );
  } catch {
    return false;
  }
}
