import { useMemo } from 'react';
import type { BottomTabNavigationOptions } from 'expo-router/js-tabs';
import { useAppTheme } from '../theme/ThemeContext';

/**
 * The three tab shells' shared options, in the phone's appearance: the bar on
 * its own ground with a hairline above it, the active tab in the accent and
 * the others in muted ink (both 4.5:1 on the bar, theme/contrast.test.ts),
 * and each scene's ground the page's, so no light frame shows between screens.
 */
export function useTabScreenOptions(): BottomTabNavigationOptions {
  const { colors } = useAppTheme();
  return useMemo(
    () => ({
      headerShown: false,
      tabBarStyle: { backgroundColor: colors.tabBar, borderTopColor: colors.borderSubtle },
      tabBarActiveTintColor: colors.primary,
      tabBarInactiveTintColor: colors.textMuted,
      sceneStyle: { backgroundColor: colors.background },
    }),
    [colors],
  );
}
