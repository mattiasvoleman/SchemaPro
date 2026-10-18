import React, { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { useNetwork } from './NetworkContext';
import { useSecureAuth } from '../hooks/useSecureAuth';
import type { AuthErrorCode } from '../services/auth/authService';
import type { AuthState } from '../types';

interface AuthContextValue {
  readonly authState: AuthState;
  readonly isLoading: boolean;
  readonly error: AuthErrorCode | null;
  readonly login: (email: string, password: string) => Promise<void>;
  readonly loginWithSchoolAccount: (email: string) => Promise<void>;
  readonly logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Wraps the app with authenticated state.
 * On mount, attempts to restore a persisted session from expo-secure-store
 * so the teacher is not forced to log in after every app restart.
 */
export function AuthProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const { authState, isLoading, error, login, loginWithSchoolAccount, logout, restoreSession, recheckProfile } = useSecureAuth();
  const online = useNetwork().networkState.isInternetReachable;

  useEffect(() => {
    void restoreSession();
  }, [restoreSession]);

  // Once signed in and online, and again whenever the app comes back to the
  // front: the role as the school has it now. After routing, so an offline
  // start never waits for it.
  const signedInAs = authState.isAuthenticated ? authState.teacherId : null;
  const latest = useRef(authState);
  latest.current = authState;
  useEffect(() => {
    if (!signedInAs || !online) return;
    void recheckProfile(latest.current);
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void recheckProfile(latest.current);
    });
    return () => subscription.remove();
  }, [signedInAs, online, recheckProfile]);

  return (
    <AuthContext.Provider value={{ authState, isLoading, error, login, loginWithSchoolAccount, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
