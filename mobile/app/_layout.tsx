import React, { useEffect } from 'react';
import { Slot, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { AuthProvider, useAuth } from '../src/context/AuthContext';
import { LocaleProvider, useI18n } from '../src/context/LocaleContext';
import { NetworkProvider } from '../src/context/NetworkContext';
import { SyncProvider } from '../src/context/SyncContext';
import {
  ensureAndroidChannel,
  refreshRegistration,
  releasePending,
} from '../src/services/pushRegistration';

// A push that arrives while the app is open is shown as a banner and kept in
// the list, silently: the inbox tab is where it is read.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

function notificationsRoute(role: string | null): '/(guardian)/notifications' | '/(student)/notifications' | '/(app)/notifications' {
  if (role === 'GUARDIAN') return '/(guardian)/notifications';
  if (role === 'STUDENT') return '/(student)/notifications';
  return '/(app)/notifications';
}

// ─────────────────────────────────────────────────────────────────────────────
// AuthGate — redirects unauthenticated users to login and vice-versa.
// Must be rendered inside <AuthProvider> so it can read auth state.
// ─────────────────────────────────────────────────────────────────────────────

function AuthGate(): React.JSX.Element {
  const { authState, isLoading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === '(auth)';
    const homeGroup =
      authState.role === 'GUARDIAN'
        ? '(guardian)'
        : authState.role === 'STUDENT'
          ? '(student)'
          : '(app)';
    const homeRoute =
      authState.role === 'GUARDIAN'
        ? '/(guardian)/children'
        : authState.role === 'STUDENT'
          ? '/(student)/schedule'
          : '/(app)/schedule';

    if (!authState.isAuthenticated && !inAuthGroup) {
      router.replace('/(auth)/login');
    } else if (authState.isAuthenticated && (inAuthGroup || segments[0] !== homeGroup)) {
      router.replace(homeRoute);
    }
  }, [authState.isAuthenticated, isLoading, segments, router]);

  return <Slot />;
}

// ─────────────────────────────────────────────────────────────────────────────
// PushBridge — the signed-in side of push (services/pushRegistration.ts).
//
// At a signed-in start: release a token a failed logout left registered, then
// refresh the signed-in person's OWN registration if they turned push on (never
// asking the phone again). The Android channel follows the language. A tap on a
// notification opens the role's Notiser tab — every role has one.
// ─────────────────────────────────────────────────────────────────────────────

function PushBridge(): null {
  const { authState } = useAuth();
  const { locale, t } = useI18n();
  const router = useRouter();
  const userId = authState.isAuthenticated ? authState.teacherId : null;
  const role = authState.role;

  useEffect(() => {
    void ensureAndroidChannel(t('push.channelName'));
  }, [t]);

  useEffect(() => {
    if (!userId) return;
    void (async () => {
      await releasePending();
      await refreshRegistration(userId, locale);
    })();
    // The locale is read at start only; Settings re-registers on a change.
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!userId) return;
    const open = (): void => router.push(notificationsRoute(role));
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    // A tap that launched the app arrived before this listener existed.
    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) open();
      })
      .catch(() => undefined);
    return () => subscription.remove();
  }, [userId, role, router]);

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// RootLayout — provider tree wired in dependency order:
//   LocaleProvider  (no deps; every screen's words, the login's included)
//     └─ NetworkProvider  (no deps)
//          └─ AuthProvider  (reads secure store on mount)
//               └─ SyncProvider  (needs auth state to start workers)
//                    └─ PushBridge + AuthGate  (need auth state)
// ─────────────────────────────────────────────────────────────────────────────

export default function RootLayout(): React.JSX.Element {
  return (
    <LocaleProvider>
      <NetworkProvider>
        <AuthProvider>
          <SyncProvider>
            <StatusBar style="light" />
            <PushBridge />
            <AuthGate />
          </SyncProvider>
        </AuthProvider>
      </NetworkProvider>
    </LocaleProvider>
  );
}
