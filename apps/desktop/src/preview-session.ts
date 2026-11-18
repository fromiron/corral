import type { Session } from 'electron';
import { type DesktopPreviewTarget, previewRequestAllowed } from './preview-policy.ts';

/**
 * The lease rules on a preview's own in-memory session (desktop-contract.md ABS-04): no
 * permission, no download, only the lease's origin and path, its header on every request, and
 * a CSP appended to the server's own. The preview window and the browser tab's preview page
 * both use it.
 */
export function applyLeaseRules(partition: Session, target: DesktopPreviewTarget) {
  partition.setPermissionCheckHandler(() => false);
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.on('will-download', (event) => event.preventDefault());
  partition.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !previewRequestAllowed(target, details.url, details.resourceType) });
  });
  partition.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, ...target.headers } });
  });
  partition.webRequest.onHeadersReceived((details, callback) => {
    // The proxy's own CSP may be stricter. Append a policy, never relax that policy.
    const headers = { ...details.responseHeaders };
    const csp = `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src ${target.origin} ${(target.webSocketOrigins ?? []).join(' ')}; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'`;
    const existing = Object.keys(headers).find(
      (name) => name.toLowerCase() === 'content-security-policy',
    );
    headers[existing ?? 'Content-Security-Policy'] = [
      ...(existing ? (headers[existing] ?? []) : []),
      csp,
    ];
    callback({ responseHeaders: headers });
  });
}
