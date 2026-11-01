import React from 'react';
import { Tabs } from 'expo-router';
import { useI18n } from '../../src/context/LocaleContext';
import { useTabScreenOptions } from '../../src/screens/tabScreenOptions';
import { TabGlyph } from '../../src/screens/TabGlyph';

/**
 * Teacher and admin shell: schedule (read-only, RLS reads), attendance
 * (offline-first queue), the notification inbox — the tab a push opens, and
 * staff receive pushes too (cover bookings, withdrawals, room bookings,
 * lesson changes) — and settings. Navigation guards are handled by AuthGate
 * in the root _layout.tsx.
 */
export default function AppLayout(): React.JSX.Element {
  const { t } = useI18n();
  const screenOptions = useTabScreenOptions();
  return (
    <Tabs
      screenOptions={screenOptions}
    >
      <Tabs.Screen
        name="schedule"
        options={{
          title: t('tabs.schedule'),
          tabBarIcon: ({ color, focused }) => <TabGlyph glyph="▦" color={color} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="attendance"
        options={{
          title: t('tabs.attendance'),
          tabBarIcon: ({ color, focused }) => <TabGlyph glyph="✓" color={color} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: t('tabs.notifications'),
          tabBarIcon: ({ color, focused }) => <TabGlyph glyph="🔔" color={color} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t('tabs.settings'),
          tabBarIcon: ({ color, focused }) => <TabGlyph glyph="⚙" color={color} focused={focused} />,
        }}
      />
    </Tabs>
  );
}
