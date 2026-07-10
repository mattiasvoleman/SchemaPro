import React from 'react';
import { Text, type ColorValue } from 'react-native';
import { Tabs } from 'expo-router';

function TabGlyph({ glyph, color }: { readonly glyph: string; readonly color: ColorValue }): React.JSX.Element {
  return <Text style={{ fontSize: 18, color }}>{glyph}</Text>;
}

/**
 * Protected app shell — bottom tabs for the two teacher workflows:
 * schedule (read-only, RLS reads) and attendance (offline-first queue).
 * Navigation guards are handled by AuthGate in the root _layout.tsx.
 */
export default function AppLayout(): React.JSX.Element {
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
          title: 'Schedule',
          tabBarIcon: ({ color }) => <TabGlyph glyph="▦" color={color} />,
        }}
      />
      <Tabs.Screen
        name="attendance"
        options={{
          title: 'Attendance',
          tabBarIcon: ({ color }) => <TabGlyph glyph="✓" color={color} />,
        }}
      />
    </Tabs>
  );
}
