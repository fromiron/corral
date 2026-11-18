// Rules for the session panel's browser tab (docs/specs/features/browser-tab.md) that need no
// Electron object: what the address field opens, which keys Corral takes from a page, when a
// page may open a new window, and how a permission request is answered.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Only these three hosts are loopback for the browser tab (not 127.0.0.2, the lease host). */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase());
}

const parse = (value: string) => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/** An http(s) URL without its user name and password, or null. */
function webUrl(value: string): URL | null {
  const url = parse(value);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null;
  url.username = '';
  url.password = '';
  return url;
}

/**
 * What the address field opens: http(s) only. Without a scheme, `https://` is added, or
 * `http://` for a loopback host. Anything else (spaces, other schemes) opens nothing and is
 * never sent to a search engine.
 */
export function browserAddress(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 8192) return null;
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  // `localhost:5173` is a host and a port, not a scheme.
  const port = scheme && /^\d+(?:[/?#]|$)/.test(text.slice(scheme[0].length));
  if (scheme && !port) {
    const name = (scheme[1] ?? '').toLowerCase();
    return name === 'http' || name === 'https' ? (webUrl(text)?.href ?? null) : null;
  }
  const host = parse(`http://${text}`)?.hostname ?? '';
  return webUrl(`${isLoopbackHost(host) ? 'http' : 'https'}://${text}`)?.href ?? null;
}

/** An address the system browser may open: http(s), credentials removed. */
export function systemBrowserUrl(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 8192 ? (webUrl(value)?.href ?? null) : null;
}

/** The http(s) origin of an address, or null. */
export function webOrigin(value: unknown): string | null {
  return typeof value === 'string' ? (webUrl(value)?.origin ?? null) : null;
}

export interface PageChord {
  id: string;
  /** `KeyboardEvent.key` without case; `Digit` matches 1–9. */
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/**
 * The app shortcuts with Mod from the studio's registry (`apps/studio/src/shortcuts.ts`,
 * desktop chords), taken from a page before it sees them. A test keeps the two lists equal.
 * Alt-only chords stay with the page.
 */
export const APP_PAGE_SHORTCUTS: readonly PageChord[] = [
  { id: 'palette', key: 'k', mod: true },
  { id: 'help', key: '/', mod: true },
  { id: 'session.new', key: 'n', mod: true },
  { id: 'session.jump', key: 'Digit', mod: true },
  { id: 'view.sidebar', key: 'b', mod: true },
  { id: 'view.panel', key: 'b', mod: true, alt: true },
  { id: 'view.dock', key: 'j', mod: true },
  { id: 'composer.focus', key: 'l', mod: true },
  { id: 'settings', key: ',', mod: true },
  { id: 'nav.back', key: '[', mod: true },
  { id: 'nav.forward', key: ']', mod: true },
  { id: 'run.stop', key: '.', mod: true },
];

/** The host's current app chords (its rebindings), validated. */
export function pageShortcuts(value: unknown): PageChord[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('Invalid browser shortcuts');
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Invalid browser shortcut');
    const chord = raw as Record<string, unknown>;
    if (
      Object.keys(chord).some((name) => !['id', 'key', 'mod', 'shift', 'alt'].includes(name)) ||
      typeof chord.id !== 'string' ||
      !/^[a-z][a-z.]{0,39}$/.test(chord.id) ||
      chord.mod !== true ||
      typeof chord.key !== 'string' ||
      !/^(?:[a-z0-9,./[\]]|Digit)$/i.test(chord.key) ||
      (chord.shift !== undefined && typeof chord.shift !== 'boolean') ||
      (chord.alt !== undefined && typeof chord.alt !== 'boolean')
    )
      throw new Error('Invalid browser shortcut');
    return {
      id: chord.id,
      key: chord.key,
      mod: true,
      ...(chord.shift ? { shift: true } : {}),
      ...(chord.alt ? { alt: true } : {}),
    };
  });
}

export interface PageKeyInput {
  type: string;
  key: string;
  code: string;
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
  isComposing: boolean;
}

export type PageKey =
  | { action: 'leave' }
  | { action: 'reload' }
  | { action: 'zoom'; zoom: 'in' | 'out' | 'reset' }
  | { action: 'shortcut'; id: string; digit?: number };

/**
 * Which key Corral takes from a page before the page sees it: Shift+Escape, Mod+R, the zoom
 * keys, then the app's shortcuts. Both the key's down and up match, so neither reaches the page.
 * Composition belongs to the IME.
 */
export function pageKey(
  input: PageKeyInput,
  chords: readonly PageChord[],
  mac: boolean,
): PageKey | null {
  if (input.isComposing || (input.type !== 'keyDown' && input.type !== 'keyUp')) return null;
  if (input.key === 'Escape' && input.shift && !input.control && !input.alt && !input.meta)
    return { action: 'leave' };
  const mod = mac ? input.meta : input.control;
  const other = mac ? input.control : input.meta;
  if (!mod || other) return null;
  const key = input.key.toLowerCase();
  if (!input.alt) {
    if (key === 'r' && !input.shift) return { action: 'reload' };
    if (key === '=' || key === '+' || input.code === 'NumpadAdd')
      return { action: 'zoom', zoom: 'in' };
    if (!input.shift && (key === '-' || input.code === 'NumpadSubtract'))
      return { action: 'zoom', zoom: 'out' };
    if (!input.shift && (key === '0' || input.code === 'Numpad0'))
      return { action: 'zoom', zoom: 'reset' };
  }
  for (const chord of chords) {
    if (!chord.mod || Boolean(chord.alt) !== input.alt || Boolean(chord.shift) !== input.shift)
      continue;
    if (chord.key === 'Digit') {
      const digit = /^Digit([1-9])$/.exec(input.code)?.[1];
      if (digit) return { action: 'shortcut', id: chord.id, digit: Number(digit) };
      continue;
    }
    // Alt changes `key` on a Mac keyboard (⌥B is ∫); the physical key decides then.
    const pressed = chord.alt && /^Key[A-Z]$/.test(input.code) ? input.code.slice(3) : input.key;
    if (pressed.toLowerCase() === chord.key.toLowerCase())
      return { action: 'shortcut', id: chord.id };
  }
  return null;
}

const MIN_ZOOM = Math.log(0.25) / Math.log(1.2);
const MAX_ZOOM = Math.log(5) / Math.log(1.2);

/** The next zoom level, in the half levels the View menu's roles use, within Chromium's range. */
export function zoomLevel(level: number, zoom: 'in' | 'out' | 'reset'): number {
  if (zoom === 'reset') return 0;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, level + (zoom === 'in' ? 0.5 : -0.5)));
}

/**
 * A page may open one new window per press or click it received in the last 5 s, counted from
 * the documented `input-event` (mouseDown, key down). The last input is a single slot, not a
 * count, and opening a window uses it up.
 */
export class NewWindowActivation {
  private readonly now: () => number;
  private at: number | null = null;
  constructor(now: () => number) {
    this.now = now;
  }
  input(type: string) {
    if (type === 'mouseDown' || type === 'rawKeyDown' || type === 'keyDown' || type === 'touchEnd')
      this.at = this.now();
  }
  take(): boolean {
    const at = this.at;
    if (at === null || this.now() - at > 5000) return false;
    this.at = null;
    return true;
  }
}

/** A permission as Corral asks and remembers it, per site (origin). */
export type SitePermission =
  | 'camera'
  | 'microphone'
  | 'geolocation'
  | 'notifications'
  | 'clipboard-read'
  | 'display-capture'
  | 'open-external'
  | 'midi-sysex'
  | 'idle-detection'
  | 'window-management'
  | 'local-fonts'
  | 'file-system'
  | 'storage-access'
  | 'pointer-lock'
  | 'speaker-selection'
  | 'local-network'
  | 'captured-surface-control';

export const SITE_PERMISSIONS: readonly SitePermission[] = [
  'camera',
  'microphone',
  'geolocation',
  'notifications',
  'clipboard-read',
  'display-capture',
  'open-external',
  'midi-sysex',
  'idle-detection',
  'window-management',
  'local-fonts',
  'file-system',
  'storage-access',
  'pointer-lock',
  'speaker-selection',
  'local-network',
  'captured-surface-control',
];

/** Electron's permission names that Chromium asks a person about, and what Corral calls them. */
const ASKED: Record<string, SitePermission> = {
  geolocation: 'geolocation',
  'geolocation-approximate': 'geolocation',
  notifications: 'notifications',
  'clipboard-read': 'clipboard-read',
  'display-capture': 'display-capture',
  openExternal: 'open-external',
  midiSysex: 'midi-sysex',
  'idle-detection': 'idle-detection',
  'window-management': 'window-management',
  'local-fonts': 'local-fonts',
  fileSystem: 'file-system',
  'storage-access': 'storage-access',
  'top-level-storage-access': 'storage-access',
  pointerLock: 'pointer-lock',
  'speaker-selection': 'speaker-selection',
  'local-network': 'local-network',
  'local-network-access': 'local-network',
  'loopback-network': 'local-network',
  'captured-surface-control': 'captured-surface-control',
};

/**
 * What Chromium grants a site without asking. Everything not asked or granted is refused,
 * including fullscreen and the device pickers (USB, HID, serial).
 */
const GRANTED = new Set([
  'clipboard-sanitized-write',
  'background-sync',
  'background-fetch',
  'screen-wake-lock',
  'sensors',
  'midi',
  'persistent-storage',
  'mediaKeySystem',
]);

export type PermissionDecision =
  | { kind: 'grant' }
  | { kind: 'deny' }
  | { kind: 'ask'; permissions: SitePermission[] };

/** How an ordinary page's permission request is answered: at once, or by asking per site. */
export function permissionRequest(
  permission: string,
  mediaTypes?: readonly string[],
): PermissionDecision {
  if (permission === 'media') {
    const asked: SitePermission[] = [];
    if (mediaTypes?.includes('video')) asked.push('camera');
    if (mediaTypes?.includes('audio')) asked.push('microphone');
    return asked.length ? { kind: 'ask', permissions: asked } : { kind: 'deny' };
  }
  const asked = ASKED[permission];
  if (asked) return { kind: 'ask', permissions: [asked] };
  return GRANTED.has(permission) ? { kind: 'grant' } : { kind: 'deny' };
}

/**
 * How a page's read of a permission's state is answered. A site Corral has not asked about
 * reads as denied: Electron has no "prompt" state, and granted would let it use the API.
 */
export function permissionCheck(
  permission: string,
  mediaType?: string,
): { kind: 'grant' | 'deny' } | { kind: 'stored'; permission: SitePermission } {
  if (permission === 'media') {
    if (mediaType === 'video') return { kind: 'stored', permission: 'camera' };
    if (mediaType === 'audio') return { kind: 'stored', permission: 'microphone' };
    return { kind: 'deny' };
  }
  const asked = ASKED[permission];
  if (asked) return { kind: 'stored', permission: asked };
  return { kind: GRANTED.has(permission) ? 'grant' : 'deny' };
}

export type CertificateReason =
  | 'expired'
  | 'name-mismatch'
  | 'self-signed'
  | 'untrusted'
  | 'revoked'
  | 'other';

/** Chromium's certificate error, in the words the error page uses. */
export function certificateReason(error: string, selfSigned: boolean): CertificateReason {
  if (error.endsWith('ERR_CERT_DATE_INVALID')) return 'expired';
  if (error.endsWith('ERR_CERT_COMMON_NAME_INVALID')) return 'name-mismatch';
  if (error.endsWith('ERR_CERT_AUTHORITY_INVALID')) return selfSigned ? 'self-signed' : 'untrusted';
  if (error.endsWith('ERR_CERT_REVOKED')) return 'revoked';
  return 'other';
}

export type LoadFailureKind =
  | 'name-not-resolved'
  | 'connection-refused'
  | 'timed-out'
  | 'offline'
  | 'certificate'
  | 'other';

/** Chromium's net error for a main-frame load, or null when the load was only cancelled. */
export function loadFailure(code: number): LoadFailureKind | null {
  if (code === -3) return null;
  if (code === -105 || code === -137) return 'name-not-resolved';
  if (code === -102 || code === -109) return 'connection-refused';
  if (code === -7 || code === -118) return 'timed-out';
  if (code === -106) return 'offline';
  if (code <= -200 && code > -300) return 'certificate';
  return 'other';
}
