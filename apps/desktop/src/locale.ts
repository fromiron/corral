// The language of native surfaces (menus, dialogs, the remote hosts window). The app's own
// language choice wins; without one they follow the operating system (#84 SET-S13).

export type DesktopLocale = 'en' | 'ko';

/** Only the languages Studio ships; anything else is refused. */
export function parseDesktopLocale(value: unknown): DesktopLocale | null {
  return value === 'en' || value === 'ko' ? value : null;
}

export function nativeLocale(chosen: DesktopLocale | undefined, system: string): DesktopLocale {
  return chosen ?? (system.toLowerCase().startsWith('ko') ? 'ko' : 'en');
}
