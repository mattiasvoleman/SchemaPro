import React, { createContext, useContext, useEffect } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { DarkTheme, DefaultTheme, ThemeProvider as NavigationThemeProvider, type Theme as NavigationTheme } from 'expo-router';
import { schemeOf } from './scheme';
import { PALETTES, type Palette, type SchemeName } from './tokens';

export interface AppTheme {
  readonly scheme: SchemeName;
  readonly colors: Palette;
  /** expo-status-bar's style: dark glyphs on the light page, light on the dark. */
  readonly statusBar: 'light' | 'dark';
  /** What the router's own views paint: a tab scene's ground, the tab bar's defaults. */
  readonly navigation: NavigationTheme;
}

function build(scheme: SchemeName): AppTheme {
  const colors = PALETTES[scheme];
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  return {
    scheme,
    colors,
    statusBar: scheme === 'dark' ? 'light' : 'dark',
    navigation: {
      ...base,
      colors: {
        primary: colors.primary,
        background: colors.background,
        card: colors.tabBar,
        text: colors.text,
        border: colors.borderSubtle,
        notification: colors.danger,
      },
    },
  };
}

/** Built once per appearance, so a screen's memoised styles stay valid. */
const THEMES: Readonly<Record<SchemeName, AppTheme>> = { light: build('light'), dark: build('dark') };

const ThemeContext = createContext<AppTheme>(THEMES.light);

/**
 * Follows the phone's appearance while the app runs (useColorScheme listens
 * to Appearance), and paints the native root view to match: the colour iOS
 * shows behind the keyboard and a rotating iPad, and that Android shows when
 * a view resizes. iOS keeps the last colour set here for the next launch
 * (ExpoSystemUI.backgroundColor in UserDefaults); app.json's backgroundColor
 * is only the very first launch's.
 */
export function AppThemeProvider({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const theme = THEMES[schemeOf(useColorScheme())];
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(theme.colors.background).catch(() => undefined);
  }, [theme]);
  return (
    <ThemeContext.Provider value={theme}>
      <NavigationThemeProvider value={theme.navigation}>{children}</NavigationThemeProvider>
    </ThemeContext.Provider>
  );
}

export function useAppTheme(): AppTheme {
  return useContext(ThemeContext);
}

/**
 * A screen's styles from the palette, one StyleSheet per appearance, made the
 * first time that appearance is drawn and kept for the module's life:
 *
 *   const useStyles = makeStyles((c) => ({ container: { flex: 1, backgroundColor: c.background } }));
 *   ...
 *   const styles = useStyles();
 */
export function makeStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (colors: Palette) => T & StyleSheet.NamedStyles<any>,
): () => T {
  const made: Partial<Record<SchemeName, T>> = {};
  return function useStyles(): T {
    const { scheme, colors } = useAppTheme();
    return (made[scheme] ??= StyleSheet.create(factory(colors)));
  };
}
