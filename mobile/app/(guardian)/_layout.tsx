import React from 'react';
import { Tabs } from 'expo-router';
import { useI18n } from '../../src/context/LocaleContext';
import { useTabScreenOptions } from '../../src/screens/tabScreenOptions';
import { TabGlyph } from '../../src/screens/TabGlyph';

/** Guardian shell — children and absence, each child's schedule, leave requests, notifications, settings. */
export default function GuardianLayout(): React.JSX.Element {
  const { t } = useI18n();
  const screenOptions = useTabScreenOptions();
  return (
    <Tabs
      screenOptions={screenOptions}
    >
      <Tabs.Screen
        name="children"
        options={{
          title: t('tabs.children'),
          tabBarIcon: ({ color, focused }) => <TabGlyph glyph="⌂" color={color} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="schedule"
        options={{
          title: t('tabs.schedule'),
          tabBarIcon: ({ color, focused }) => <TabGlyph glyph="▦" color={color} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="leave"
        options={{
          title: t('tabs.leave'),
          tabBarIcon: ({ color, focused }) => <TabGlyph glyph="✈" color={color} focused={focused} />,
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
