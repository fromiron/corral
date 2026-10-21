import type { PortableApplication } from '@corral/client';
import { canonicalJson } from '@corral/contracts';
import {
  bindingError,
  readShortcutBindings,
  type ShortcutBindings,
  writeShortcutBindings,
} from '../shortcutBindings.ts';
import { SHORTCUTS } from '../shortcuts.ts';
import {
  changePreferences,
  PREFERENCES_KEY,
  parsePreferences,
  preferences,
} from './preferences.ts';

export function portablePreferences(locale: 'en' | 'ko'): PortableApplication {
  const { theme, sendKey, notify } = preferences.getState();
  return { version: 1, theme, sendKey, notify, locale, shortcuts: readShortcutBindings() };
}
async function revision(value: PortableApplication) {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(value)),
  );
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
/** Applies through existing owners and acknowledges only persisted readback, not React state. */
export async function applyPortablePreferences(
  target: PortableApplication,
  expectedRevision: string,
  locale: 'en' | 'ko',
  setLocale: (value: 'en' | 'ko') => void,
) {
  const current = portablePreferences(locale);
  if (target.shortcuts) {
    const desktop = Boolean((globalThis as { corralDesktop?: unknown }).corralDesktop);
    const defaults = Object.fromEntries(
      SHORTCUTS.flatMap((shortcut) => {
        const chord = !desktop && shortcut.web !== undefined ? shortcut.web : shortcut.chord;
        return chord ? [[shortcut.id, chord]] : [];
      }),
    ) as ShortcutBindings;
    const effective = { ...defaults, ...target.shortcuts };
    for (const shortcut of SHORTCUTS) {
      const chord = target.shortcuts[shortcut.id];
      if (chord && bindingError(shortcut.id, chord, effective, desktop))
        throw new Error(
          `The shortcut for ${shortcut.id} is reserved or conflicts on this device. Choose local keys before applying.`,
        );
    }
  }
  // Older v1 exports without shortcut overrides leave local bindings unchanged.
  if (!target.shortcuts) delete current.shortcuts;
  const [actual, desired] = await Promise.all([revision(current), revision(target)]);
  if (actual !== expectedRevision && actual !== desired)
    throw new Error('Browser preferences changed since preview. Preview or recover again.');
  if (target.shortcuts) writeShortcutBindings(target.shortcuts);
  changePreferences({ theme: target.theme, sendKey: target.sendKey, notify: target.notify });
  setLocale(target.locale);
  const saved = parsePreferences(localStorage.getItem(PREFERENCES_KEY));
  const readback: PortableApplication = {
    version: 1,
    theme: saved.theme,
    sendKey: saved.sendKey,
    notify: saved.notify,
    locale: localStorage.getItem('corral:locale') === 'ko' ? 'ko' : 'en',
    ...(target.shortcuts ? { shortcuts: readShortcutBindings() } : {}),
  };
  if ((await revision(readback)) !== desired)
    throw new Error(
      'Browser storage did not persist the imported preferences. Recovery remains pending.',
    );
  return readback;
}
