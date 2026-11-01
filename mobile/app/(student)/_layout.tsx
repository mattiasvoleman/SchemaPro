import React from 'react';
import { Tabs } from 'expo-router';
import { useI18n } from '../../src/context/LocaleContext';
import { useTabScreenOptions } from '../../src/screens/tabScreenOptions';
import { TabGlyph } from '../../src/screens/TabGlyph';

/** Student shell — personal schedule, notifications, settings. */
export default function StudentLayout(): React.JSX.Element {
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
