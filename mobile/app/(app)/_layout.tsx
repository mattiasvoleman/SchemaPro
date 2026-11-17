import React from 'react';
import { Tabs } from 'expo-router';
import { useAuth } from '../../src/context/AuthContext';
import { useI18n } from '../../src/context/LocaleContext';
import { useTabScreenOptions } from '../../src/screens/tabScreenOptions';
import { TabGlyph } from '../../src/screens/TabGlyph';
import { appTabs } from '../../src/services/auth/appGate';

/**
 * Teacher and admin shell: schedule (read-only, RLS reads), attendance
 * (offline-first queue), the notification inbox — the tab a push opens, and
 * staff receive pushes too (cover bookings, withdrawals, room bookings,
 * lesson changes) — and settings. Navigation guards are handled by AuthGate
 * in the root _layout.tsx.
 *
 * A TEACHER also has Vikarie (cover requests, Vikariefrågan): the questions
 * the school asks them and the passes they hold. The administrator shares
 * this shell but is not asked, so the tab is hidden for them (href: null
 * keeps the route and takes the tab off the bar). That holds for an
 * administrator who teaches (Users.teaches) too: the gateway refuses every
 * cover-request route to an administrator and the substitute pool refuses
 * one (SP409), so the mark does not open the tab.
 *
 * Both have Larm (Krisläge): a teacher counts their groups when an alarm is
 * going, an administrator starts it, watches the count and ends it, and an
 * administrator who teaches counts their own groups first and has the
 * administration's view one tap away (CrisisScreen). It sits beside the tabs
 * a teacher works in all day, and a push about an alarm opens it
 * (services/auth/appGate.ts tapTarget).
 *
 * Which tabs a role has is decided in appGate.appTabs, one place for this
 * bar, for a push tap and for the screens behind the tabs.
 */
export default function AppLayout(): React.JSX.Element {
  const { t } = useI18n();
  const { authState } = useAuth();
  const tabs = appTabs(authState.role, authState.teaches);
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
        name="cover-requests"
        options={{
          title: t('coverRequests.tab'),
          href: tabs.cover ? undefined : null,
          tabBarIcon: ({ color, focused }) => <TabGlyph glyph="⇄" color={color} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="crisis"
        options={{
          title: t('crisis.tab'),
          href: tabs.crisis ? undefined : null,
          tabBarIcon: ({ color, focused }) => <TabGlyph glyph="⚠" color={color} focused={focused} />,
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
