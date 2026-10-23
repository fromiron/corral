import { enMessages, koMessages } from '@corral/react';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { IntlProvider } from 'use-intl';

// UI language (roadmap UX-A5): English or Korean. The visitor's choice is a per-browser
// convenience in localStorage; without one, the browser's language decides.

export type Locale = 'en' | 'ko';
export const LOCALES: readonly { id: Locale; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'ko', name: '한국어' },
];
const KEY = 'corral:locale';
const MESSAGES = { en: enMessages, ko: koMessages };

export function initialLocale(
  stored: string | null,
  languages: readonly string[] = globalThis.navigator?.languages ?? [],
): Locale {
  if (stored === 'en' || stored === 'ko') return stored;
  return languages.some((l) => l.toLowerCase().startsWith('ko')) ? 'ko' : 'en';
}

function readStored(): string | null {
  try {
    return globalThis.localStorage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

const LocaleContext = createContext<{ locale: Locale; setLocale(locale: Locale): void }>({
  locale: 'en',
  setLocale: () => {},
});

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale(readStored()));
  useEffect(() => {
    document.documentElement.lang = locale;
    // A chosen language also names the desktop menus and dialogs; without a choice they keep
    // following the system, as the page does (#84).
    if (readStored()) void window.corralDesktop?.locale?.(locale).catch(() => {});
  }, [locale]);
  const setLocale = (next: Locale) => {
    setLocaleState(next);
    try {
      globalThis.localStorage?.setItem(KEY, next);
    } catch {
      // Storage refused: the choice lasts for this tab only.
    }
  };
  return (
    <LocaleContext.Provider value={{ locale, setLocale }}>
      <IntlProvider
        locale={locale}
        messages={MESSAGES[locale]}
        timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
      >
        {children}
      </IntlProvider>
    </LocaleContext.Provider>
  );
}

export const useLocale = () => useContext(LocaleContext);
