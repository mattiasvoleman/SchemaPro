import React, { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useSecureAuth } from '../hooks/useSecureAuth';
import type { AuthErrorCode } from '../services/auth/authService';
import type { AuthState } from '../types';

interface AuthContextValue {
  readonly authState: AuthState;
  readonly isLoading: boolean;
  readonly error: AuthErrorCode | null;
  readonly login: (email: string, password: string) => Promise<void>;
  readonly logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Wraps the app with authenticated state.
 * On mount, attempts to restore a persisted session from expo-secure-store
 * so the teacher is not forced to log in after every app restart.
 */
export function AuthProvider({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const { authState, isLoading, error, login, logout, restoreSession } = useSecureAuth();

  useEffect(() => {
    void restoreSession();
  }, [restoreSession]);

  return (
    <AuthContext.Provider value={{ authState, isLoading, error, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
