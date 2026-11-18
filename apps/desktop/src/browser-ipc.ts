import type { WebContents, WebFrameMain } from 'electron';
import { ANNOTATE_CALLS, jsonWithin } from './annotate-overlay.ts';
import type { BrowserRect } from './browser-bridge.ts';
import { pageShortcuts, SITE_PERMISSIONS, type SitePermission } from './browser-policy.ts';
import type { BrowserTabs } from './browser-tabs.ts';
import { previewCaptureOptions } from './preview-capture.ts';

// The studio's browser calls (preload.cjs `browser`), each registered by main's `handle()`,
// which accepts only the app's own main frame. Every argument is checked again here.

const TOKEN = /^[A-Za-z0-9_-]{1,80}$/;

const token = (value: unknown): string => {
  if (typeof value !== 'string' || !TOKEN.test(value)) throw new Error('Invalid browser request');
  return value;
};
const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid browser request');
  return value;
};
const project = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value))
    throw new Error('Invalid browser request');
  return value;
};
const lease = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(value))
    throw new Error('Invalid browser request');
  return value;
};
const flag = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new Error('Invalid browser request');
  return value;
};
const rect = (value: unknown): BrowserRect | null => {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid browser request');
  const box = value as Record<string, unknown>;
  const keys = Object.keys(box);
  if (keys.length !== 4 || ['x', 'y', 'width', 'height'].some((key) => !keys.includes(key)))
    throw new Error('Invalid browser request');
  const number = (entry: unknown, min: number) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < min || entry > 100_000)
      throw new Error('Invalid browser request');
    return entry;
  };
  return {
    x: number(box.x, -100_000),
    y: number(box.y, -100_000),
    width: number(box.width, 0),
    height: number(box.height, 0),
  };
};
const zoom = (value: unknown): 'in' | 'out' | 'reset' => {
  if (value !== 'in' && value !== 'out' && value !== 'reset')
    throw new Error('Invalid browser request');
  return value;
};
const permission = (value: unknown): SitePermission => {
  if (typeof value !== 'string' || !(SITE_PERMISSIONS as readonly string[]).includes(value))
    throw new Error('Invalid browser request');
  return value as SitePermission;
};
const credentials = (value: unknown): { username: string; password: string } | null => {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid browser request');
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).length !== 2) throw new Error('Invalid browser request');
  return { username: text(entry.username, 1024), password: text(entry.password, 1024) };
};

/** The handlers by channel name (main prefixes `desktop:`). */
export function browserHandlers(
  tabs: BrowserTabs,
): Record<string, (...args: unknown[]) => unknown> {
  return {
    'browser-navigate': (tabId, projectId, address) =>
      tabs.navigate(token(tabId), project(projectId), text(address, 8192)),
    'browser-open-preview': (tabId, sessionId, leaseId) =>
      tabs.openPreview(token(tabId), lease(sessionId), lease(leaseId)),
    'browser-place': (tabId, box) => tabs.place(token(tabId), rect(box)),
    'browser-close': (tabId) => tabs.close(token(tabId)),
    'browser-unload': (tabId) => tabs.unload(token(tabId)),
    'browser-reload': (tabId) => tabs.reload(token(tabId)),
    'browser-stop': (tabId) => tabs.stop(token(tabId)),
    'browser-back': (tabId) => tabs.back(token(tabId)),
    'browser-forward': (tabId) => tabs.forward(token(tabId)),
    'browser-reopen': (tabId) => tabs.reopen(token(tabId)),
    'browser-reset': (tabId) => tabs.reset(token(tabId)),
    'browser-zoom': (tabId, value) => tabs.zoom(token(tabId), zoom(value)),
    'browser-focus': (tabId) => tabs.focus(token(tabId)),
    'browser-still': (tabId) => tabs.still(token(tabId)),
    'browser-freeze': (tabId, stillId) => tabs.freeze(token(tabId), token(stillId)),
    'browser-thaw': (tabId) => tabs.thaw(token(tabId)),
    'browser-answer-permission': (tabId, requestId, allow) =>
      tabs.answerPermission(token(tabId), token(requestId), flag(allow)),
    'browser-site-permissions': (projectId, origin) =>
      tabs.sitePermissions(project(projectId), text(origin, 2048)),
    'browser-forget-permission': (projectId, origin, name) =>
      tabs.forgetPermission(project(projectId), text(origin, 2048), permission(name)),
    'browser-answer-login': (tabId, requestId, value) =>
      tabs.answerLogin(token(tabId), token(requestId), credentials(value)),
    'browser-proceed-certificate': (tabId, challengeId) =>
      tabs.proceedCertificate(token(tabId), token(challengeId)),
    'browser-downloads': (tabId) => tabs.downloads(token(tabId)),
    'browser-cancel-download': (downloadId) => tabs.cancelDownload(token(downloadId)),
    'browser-show-download': (downloadId) => tabs.showDownload(token(downloadId)),
    'browser-open-blocked': (tabId) => tabs.openBlocked(token(tabId)),
    'browser-clear-project-data': (projectId) => tabs.clearProjectData(project(projectId)),
    'browser-remove-project': (projectId) => tabs.removeProject(project(projectId)),
    'browser-set-shortcuts': (chords) => tabs.setShortcuts(pageShortcuts(chords)),
    'browser-capture-preview': (tabId, options) =>
      tabs.capturePreview(token(tabId), previewCaptureOptions(options)),
    'browser-cancel-preview-capture': (tabId) => tabs.cancelPreviewCapture(token(tabId)),
    'browser-annotate': (tabId, on) => tabs.annotate(token(tabId), flag(on)),
    'browser-annotate-context': (tabId, context) =>
      tabs.annotateContext(token(tabId), jsonWithin(context, 64 * 1024)),
    'browser-answer-annotate': (tabId, submitId, outcome) =>
      tabs.answerAnnotate(token(tabId), token(submitId), jsonWithin(outcome, 16 * 1024)),
  };
}

/**
 * The annotation overlay's calls (annotate-preload.cjs), by channel (`annotate:<name>`). Main
 * registers them straight on ipcMain: the tab manager accepts only a live overlay's main frame
 * on its own page, so neither the app page nor a web page can make them.
 */
export function annotateHandlers(
  tabs: BrowserTabs,
): Record<
  string,
  (event: { sender: WebContents; senderFrame: WebFrameMain | null }, ...args: unknown[]) => unknown
> {
  return Object.fromEntries(
    ANNOTATE_CALLS.map((name) => [
      `annotate:${name}`,
      (event: { sender: WebContents; senderFrame: WebFrameMain | null }, ...args: unknown[]) =>
        tabs.fromOverlay(event.sender, event.senderFrame, name, args),
    ]),
  );
}
