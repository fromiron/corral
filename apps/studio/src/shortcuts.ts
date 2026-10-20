// One table of keyboard shortcuts (Workbench polish P4). Tooltips, the ? help, Settings ›
// Shortcuts and the global key handler all read it, so what is shown is what works.
import { bindingError, readShortcutBindings, type ShortcutBindings } from './shortcutBindings.ts';

const isMac = () => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');
/** The desktop app owns its keys; a browser keeps Ctrl+N/W/T and digit keys for itself. */
const isDesktop = () => Boolean((globalThis as { corralDesktop?: unknown }).corralDesktop);

export interface Chord {
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** `event.key`, compared without case; `Digit` matches 1–9. */
  key: string;
}

export type ShortcutId =
  | 'palette'
  | 'help'
  | 'session.new'
  | 'session.jump'
  | 'view.sidebar'
  | 'view.panel'
  | 'composer.focus'
  | 'settings'
  | 'nav.back'
  | 'nav.forward'
  | 'run.stop';

export interface Shortcut {
  id: ShortcutId;
  /** Keys in the desktop app, and in a browser unless `web` says otherwise. */
  chord: Chord;
  /** A browser's own keys win there; null hides the shortcut in a browser. */
  web?: Chord | null;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'palette', chord: { mod: true, key: 'k' } },
  { id: 'help', chord: { mod: true, key: '/' } },
  { id: 'session.new', chord: { mod: true, key: 'n' }, web: { mod: true, alt: true, key: 'n' } },
  { id: 'session.jump', chord: { mod: true, key: 'Digit' }, web: null },
  { id: 'view.sidebar', chord: { mod: true, key: 'b' } },
  { id: 'view.panel', chord: { mod: true, alt: true, key: 'b' } },
  { id: 'composer.focus', chord: { mod: true, key: 'l' } },
  { id: 'settings', chord: { mod: true, key: ',' } },
  { id: 'nav.back', chord: { mod: true, key: '[' } },
  { id: 'nav.forward', chord: { mod: true, key: ']' } },
  { id: 'run.stop', chord: { mod: true, key: '.' } },
];

/** Keys that work only inside one place (composer, editor); listed in help, not bound here. */
export const LOCAL_KEYS = [
  {
    id: 'send',
    keys: (sendWithEnter: boolean) =>
      sendWithEnter ? 'Enter' : formatChord({ mod: true, key: 'Enter' }),
  },
  {
    id: 'newline',
    keys: (sendWithEnter: boolean) =>
      sendWithEnter ? formatChord({ shift: true, key: 'Enter' }) : 'Enter',
  },
  { id: 'recall', keys: () => '↑' },
  { id: 'mention', keys: () => '@' },
  { id: 'slash', keys: () => '/' },
  { id: 'save', keys: () => formatChord({ mod: true, key: 's' }) },
  { id: 'undo', keys: () => formatChord({ mod: true, key: 'z' }) },
  { id: 'redo', keys: () => formatChord({ mod: true, shift: true, key: 'z' }) },
  { id: 'close', keys: () => 'Esc' },
] as const;

export function chordOf(id: ShortcutId): Chord | null {
  return effectiveShortcuts()[id] ?? null;
}

export function effectiveShortcuts(serialized?: string): ShortcutBindings {
  const bindings: ShortcutBindings = {};
  for (const shortcut of SHORTCUTS) {
    const chord = isDesktop() || shortcut.web === undefined ? shortcut.chord : shortcut.web;
    if (chord) bindings[shortcut.id] = chord;
  }
  for (const [id, chord] of Object.entries(readShortcutBindings(serialized))) {
    if (
      SHORTCUTS.some((shortcut) => shortcut.id === id) &&
      !bindingError(id as ShortcutId, chord, bindings, isDesktop())
    )
      bindings[id as ShortcutId] = chord;
  }
  return bindings;
}

export function formatChord(chord: Chord): string {
  const mac = isMac();
  const key =
    chord.key === 'Digit' ? '1–9' : chord.key.length === 1 ? chord.key.toUpperCase() : chord.key;
  const parts = [
    chord.mod ? (mac ? '⌘' : 'Ctrl') : null,
    chord.alt ? (mac ? '⌥' : 'Alt') : null,
    chord.shift ? (mac ? '⇧' : 'Shift') : null,
    key,
  ].filter(Boolean);
  return parts.join(mac ? '' : '+');
}

/** What a tooltip or menu shows for a shortcut here, or undefined when it has none here. */
export function shortcutLabel(id: ShortcutId): string | undefined {
  const chord = chordOf(id);
  return chord ? formatChord(chord) : undefined;
}

/** Which shortcut a key press is, if any. IME composition never matches. */
export function shortcutFor(event: KeyboardEvent): { id: ShortcutId; digit?: number } | null {
  if (event.isComposing || event.keyCode === 229) return null;
  const mod = isMac() ? event.metaKey : event.ctrlKey;
  if ((isMac() ? event.ctrlKey : event.metaKey) || event.getModifierState?.('AltGraph'))
    return null;
  const bindings = effectiveShortcuts();
  for (const shortcut of SHORTCUTS) {
    const chord = bindings[shortcut.id];
    if (!chord) continue;
    if (Boolean(chord.mod) !== mod || Boolean(chord.alt) !== event.altKey) continue;
    if (Boolean(chord.shift) !== event.shiftKey) continue;
    if (chord.key === 'Digit') {
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (digit) return { id: shortcut.id, digit: Number(digit) };
      continue;
    }
    // Alt changes `key` on a Mac keyboard (⌥B is ∫); the physical key decides then.
    const pressed = chord.alt && /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : event.key;
    if (pressed.toLowerCase() === chord.key.toLowerCase()) return { id: shortcut.id };
  }
  return null;
}

/** The key that sends a request, as the person chose it (Settings › General). */
export function sendKeyLabel(sendKey: 'enter' | 'mod-enter'): string {
  return sendKey === 'enter' ? 'Enter' : formatChord({ mod: true, key: 'Enter' });
}
