import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { translatorFor, type Locale, type Translate } from '../i18n';
import { DEFAULT_LOCALE, loadLocale, saveLocale } from '../i18n/localeStore';

interface LocaleContextValue {
  readonly locale: Locale;
  readonly t: Translate;
  readonly setLocale: (locale: Locale) => Promise<void>;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

/**
 * The reader's language for every screen. Starts in Swedish and switches to
 * a stored English choice as soon as the keychain answers, so the first frame
 * is never an untranslated key.
 */
export function LocaleProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const [locale, setState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    let live = true;
    void loadLocale().then((stored) => {
      if (live) setState(stored);
    });
    return () => {
      live = false;
    };
  }, []);

  const setLocale = useCallback(async (next: Locale) => {
    setState(next);
    await saveLocale(next).catch(() => undefined);
  }, []);

  const value = useMemo(() => ({ locale, t: translatorFor(locale), setLocale }), [locale, setLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useI18n(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useI18n must be used inside <LocaleProvider>');
  return ctx;
}
