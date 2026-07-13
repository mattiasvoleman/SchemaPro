import React from 'react';
import { Text, type ColorValue } from 'react-native';
import { Tabs } from 'expo-router';

function TabGlyph({ glyph, color }: { readonly glyph: string; readonly color: ColorValue }): React.JSX.Element {
  return <Text style={{ fontSize: 18, color }}>{glyph}</Text>;
}

/** Guardian shell — children/absence reporting, leave requests, notifications. */
export default function GuardianLayout(): React.JSX.Element {
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
        name="children"
        options={{
          title: 'Children',
          tabBarIcon: ({ color }) => <TabGlyph glyph="⌂" color={color} />,
        }}
      />
      <Tabs.Screen
        name="leave"
        options={{
          title: 'Leave',
          tabBarIcon: ({ color }) => <TabGlyph glyph="✈" color={color} />,
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: 'Alerts',
          tabBarIcon: ({ color }) => <TabGlyph glyph="🔔" color={color} />,
        }}
      />
    </Tabs>
  );
}
