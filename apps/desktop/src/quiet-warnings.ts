import type { EventEmitter } from 'node:events';

/**
 * Electron reports a failed page load as a process warning ("Failed to load URL: <address>
 * with error: …") that carries the whole address, query included. A browser tab's addresses
 * stay off the console (features/browser-tab.md 보안·성능·접근성); every other warning
 * still reaches the listeners that were there, Node's printer among them.
 */
export function withoutPageAddresses(target: EventEmitter) {
  const before = target.listeners('warning') as ((warning: Error) => void)[];
  target.removeAllListeners('warning');
  target.on('warning', (warning: Error) => {
    if (warning?.name === 'electron' && String(warning.message).startsWith('Failed to load URL:'))
      return;
    for (const listener of before) listener(warning);
  });
}
