import React, { useEffect } from 'react';
import { Slot, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { AuthProvider, useAuth } from '../src/context/AuthContext';
import { LocaleProvider, useI18n } from '../src/context/LocaleContext';
import { NetworkProvider } from '../src/context/NetworkContext';
import { SyncProvider } from '../src/context/SyncContext';
import { AppThemeProvider, useAppTheme } from '../src/theme/ThemeContext';
import { homeOf, tapTarget, tapTypeOf } from '../src/services/auth/appGate';
import { handleCrisisPush } from '../src/services/crisisOffline';
import {
  ensureAndroidChannel,
  foregroundPresentation,
  forgetTap,
  startSignedIn,
  takeLastTap,
} from '../src/services/pushRegistration';

// A push that arrives while the app is open is shown as a banner and kept in
// the list, silently: the inbox tab is where it is read. An alarm also sounds.
Notifications.setNotificationHandler({
  handleNotification: async (notification) => foregroundPresentation(notification),
});

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
    const { group: homeGroup, home: homeRoute } = homeOf(authState.role);

    if (!authState.isAuthenticated && !inAuthGroup) {
      router.replace('/(auth)/login');
    } else if (authState.isAuthenticated && (inAuthGroup || segments[0] !== homeGroup)) {
      router.replace(homeRoute);
    }
  }, [authState.isAuthenticated, authState.role, isLoading, segments, router]);

  return <Slot />;
}

// ─────────────────────────────────────────────────────────────────────────────
// PushBridge — the signed-in side of push (services/pushRegistration.ts).
//
// At a signed-in start (startSignedIn): release a token a failed logout or a
// sign-out the app did not start left registered, then refresh the signed-in
// person's OWN registration if they turned push on (never asking the phone
// again), in the language stored on the device. The Android channel follows
// the language. A tap on a notification opens the role's Notiser tab — every
// role has one — except a cover question (COVER_REQUESTED, and its end,
// COVER_REQUEST_CLOSED), which opens a teacher's Vikarie tab where it is
// answered, an alarm (CRISIS_ALARM, CRISIS_ENDED), which opens the Larm tab of
// a teacher or an administrator, and a request to confirm a message
// (ACK_REQUESTED, and its reminder ACK_REMINDER), which opens a guardian's
// Meddelanden tab where it is confirmed (tapTarget); the tap is then
// forgotten, so no later sign-in replays it.
//
// An alarm push is also remembered for WHEN it was sent, whether it is tapped
// or only shown (services/crisisOffline.ts): a phone with no coverage when the
// alarm began builds its list from that moment. A push is never taken for the
// alarm still going: a phone that was off gets it late, so the gateway is asked
// first (handleCrisisPush) and a list is shown only for an alarm that stands.
// ─────────────────────────────────────────────────────────────────────────────

function PushBridge(): null {
  const { authState } = useAuth();
  const { locale } = useI18n();
  const router = useRouter();
  const userId = authState.isAuthenticated ? authState.teacherId : null;
  const role = authState.role;

  // The alarm's channel is made here too, before the first alarm push can arrive.
  useEffect(() => {
    void ensureAndroidChannel(locale);
  }, [locale]);

  useEffect(() => {
    if (!userId) return;
    // The language is read from the device's store inside; Settings
    // re-registers on a change.
    void startSignedIn(userId);
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    const open = (type: string | null): void => router.push(tapTarget(role, type));
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      forgetTap();
      void handleCrisisPush((response as { notification?: unknown } | null)?.notification);
      open(tapTypeOf(response));
    });
    // A push that arrives while the app is open is not a tap, and is still the news.
    const arrival = Notifications.addNotificationReceivedListener((notification) => {
      void handleCrisisPush(notification);
    });
    // A tap that launched the app arrived before this listener existed.
    const launching = takeLastTap();
    if (launching) {
      void handleCrisisPush(launching.notification);
      open(launching.type);
    }
    return () => {
      subscription.remove();
      arrival.remove();
    };
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

/** The status bar's glyphs in the appearance's contrast: dark on light, light on dark. */
function ThemedStatusBar(): React.JSX.Element {
  return <StatusBar style={useAppTheme().statusBar} />;
}

export default function RootLayout(): React.JSX.Element {
  return (
    <AppThemeProvider>
      <LocaleProvider>
        <NetworkProvider>
          <AuthProvider>
            <SyncProvider>
              <ThemedStatusBar />
              <PushBridge />
              <AuthGate />
            </SyncProvider>
          </AuthProvider>
        </NetworkProvider>
      </LocaleProvider>
    </AppThemeProvider>
  );
}
