import React, { useEffect } from 'react';
import { Slot, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from '../src/context/AuthContext';
import { NetworkProvider } from '../src/context/NetworkContext';
import { SyncProvider } from '../src/context/SyncContext';

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
// RootLayout — provider tree wired in dependency order:
//   NetworkProvider  (no deps)
//     └─ AuthProvider  (reads secure store on mount)
//          └─ SyncProvider  (needs auth state to start workers)
//               └─ AuthGate  (needs auth state for navigation guard)
// ─────────────────────────────────────────────────────────────────────────────

export default function RootLayout(): React.JSX.Element {
  return (
    <NetworkProvider>
      <AuthProvider>
        <SyncProvider>
          <StatusBar style="light" />
          <AuthGate />
        </SyncProvider>
      </AuthProvider>
    </NetworkProvider>
  );
}
