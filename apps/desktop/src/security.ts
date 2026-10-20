import { isAbsolute, win32 } from 'node:path';

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

// CR-017: what the native menu may ask the page to do. The page runs these through its own
// command registry; nothing else crosses from the menu.
export const DESKTOP_COMMANDS = [
  'palette',
  'help',
  'session.new',
  'view.sidebar',
  'view.panel',
  'settings',
  'composer.focus',
  'nav.back',
  'nav.forward',
] as const;
export type DesktopCommand = (typeof DESKTOP_COMMANDS)[number];

export function desktopCommand(value: unknown): DesktopCommand | null {
  return typeof value === 'string' && (DESKTOP_COMMANDS as readonly string[]).includes(value)
    ? (value as DesktopCommand)
    : null;
}

/** Validate the renderer's command IDs/chords before they become native accelerators. */
export function desktopAccelerators(value: unknown): Partial<Record<DesktopCommand, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid shortcut bindings');
  const accelerators: Partial<Record<DesktopCommand, string>> = {};
  const seen = new Set<string>();
  for (const [id, raw] of Object.entries(value)) {
    if (!desktopCommand(id) && !['run.stop', 'session.jump'].includes(id))
      throw new Error('Unknown shortcut command');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Invalid shortcut chord');
    const chord = raw as Record<string, unknown>;
    if (
      Object.keys(chord).some((key) => !['key', 'mod', 'shift', 'alt'].includes(key)) ||
      chord.mod !== true ||
      typeof chord.key !== 'string' ||
      (chord.alt !== undefined && typeof chord.alt !== 'boolean') ||
      (chord.shift !== undefined && typeof chord.shift !== 'boolean')
    )
      throw new Error('Invalid shortcut chord');
    if (id === 'session.jump') {
      if (chord.key !== 'Digit') throw new Error('Session jump uses digit keys');
      for (let digit = 1; digit <= 9; digit++) {
        const key = [
          'CommandOrControl',
          chord.alt ? 'Alt' : '',
          chord.shift ? 'Shift' : '',
          String(digit),
        ]
          .filter(Boolean)
          .join('+');
        if (seen.has(key)) throw new Error('Conflicting shortcut bindings');
        seen.add(key);
      }
      continue;
    }
    const key = chord.key.toLowerCase();
    if (!/^[a-z0-9,./[\]]$/.test(key) || 'acvxzysfqwt'.includes(key))
      throw new Error('This shortcut is reserved for editing or the operating system');
    const accelerator = [
      'CommandOrControl',
      chord.alt ? 'Alt' : '',
      chord.shift ? 'Shift' : '',
      key.toUpperCase(),
    ]
      .filter(Boolean)
      .join('+');
    if (seen.has(accelerator)) throw new Error('Conflicting shortcut bindings');
    seen.add(accelerator);
    const command = desktopCommand(id);
    if (command) accelerators[command] = accelerator;
  }
  return accelerators;
}

/** Window colours for the page's theme; matches packages/react/src/theme.css. */
export function themeColors(dark: unknown) {
  if (typeof dark !== 'boolean') return null;
  return dark
    ? { background: '#151615', overlay: '#151615', symbol: '#ececea' }
    : { background: '#f7f7f5', overlay: '#f7f7f5', symbol: '#1d1d1b' };
}

/** Drops control characters (terminal escapes, NUL) and trims to `max`. */
const plain = (text: string, max: number) =>
  [...text]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .trim()
    .slice(0, max);

/** A notification's title and body as short plain text, or null. */
export function notificationText(value: unknown): { title: string; body: string } | null {
  if (!value || typeof value !== 'object') return null;
  const { title, body } = value as { title?: unknown; body?: unknown };
  if (typeof title !== 'string' || typeof body !== 'string') return null;
  const clean = { title: plain(title, 120), body: plain(body, 300) };
  return clean.title ? clean : null;
}

/** Up to five absolute workspace paths, the newest first, without repeats. */
export function recentWorkspaces(list: unknown, added: string): string[] {
  const previous = Array.isArray(list) ? list : [];
  return [added, ...previous]
    .filter(
      (path): path is string =>
        typeof path === 'string' && (isAbsolute(path) || win32.isAbsolute(path)),
    )
    .filter((path, index, all) => all.indexOf(path) === index)
    .slice(0, 5);
}
