import React from 'react';
import { Text, type ColorValue } from 'react-native';
import { Tabs } from 'expo-router';
import { useI18n } from '../../src/context/LocaleContext';

function TabGlyph({ glyph, color }: { readonly glyph: string; readonly color: ColorValue }): React.JSX.Element {
  return <Text style={{ fontSize: 18, color }}>{glyph}</Text>;
}

/**
 * Teacher and admin shell: schedule (read-only, RLS reads), attendance
 * (offline-first queue), the notification inbox — the tab a push opens, and
 * staff receive pushes too (cover bookings, withdrawals, room bookings,
 * lesson changes) — and settings. Navigation guards are handled by AuthGate
 * in the root _layout.tsx.
 */
export default function AppLayout(): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#0f0f1a',
          borderTopColor: '#1e1e3a',
        },
        tabBarActiveTintColor: '#6366f1',
        tabBarInactiveTintColor: '#475569',
      }}
    >
      <Tabs.Screen
        name="schedule"
        options={{
          title: t('tabs.schedule'),
          tabBarIcon: ({ color }) => <TabGlyph glyph="▦" color={color} />,
        }}
      />
      <Tabs.Screen
        name="attendance"
        options={{
          title: t('tabs.attendance'),
          tabBarIcon: ({ color }) => <TabGlyph glyph="✓" color={color} />,
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: t('tabs.notifications'),
          tabBarIcon: ({ color }) => <TabGlyph glyph="🔔" color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t('tabs.settings'),
          tabBarIcon: ({ color }) => <TabGlyph glyph="⚙" color={color} />,
        }}
      />
    </Tabs>
  );
}
