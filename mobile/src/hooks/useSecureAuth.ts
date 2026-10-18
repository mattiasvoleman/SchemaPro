import { useCallback, useRef, useState } from 'react';
import { AuthError, AuthService, type AuthErrorCode } from '../services/auth/authService';
import type { AuthState } from '../types';

interface UseSecureAuthReturn {
  readonly authState: AuthState;
  readonly isLoading: boolean;
  /** Why the last login failed, as a code the login screen words. */
  readonly error: AuthErrorCode | null;
  readonly login: (email: string, password: string) => Promise<void>;
  /** "Logga in med skolkonto" for the typed address. */
  readonly loginWithSchoolAccount: (email: string) => Promise<void>;
  readonly logout: () => Promise<void>;
  readonly restoreSession: () => Promise<void>;
  readonly recheckProfile: (current: AuthState) => Promise<void>;
  /** While signed in: signs the app out when the server ends the session; returns the unsubscribe. */
  readonly watchSessionEnd: () => () => void;
}

const INITIAL_STATE: AuthState = {
  isAuthenticated: false,
  teacherId: null,
  role: null,
};

/**
 * Manages auth state backed entirely by expo-secure-store.
 * Exposes typed login/logout/restore functions consumed by AuthContext.
 */
export function useSecureAuth(): UseSecureAuthReturn {
  const [authState, setRenderedState] = useState<AuthState>(INITIAL_STATE);
  // The state as last set, ahead of the render that shows it: a recheck that
  // settles after a logout or another sign-in is compared with this. An
  // updater would see the same, but React runs it only at the next render,
  // too late to decide whether the login screen is told anything.
  const latest = useRef<AuthState>(INITIAL_STATE);
  const setAuthState = useCallback((next: AuthState): void => {
    latest.current = next;
    setRenderedState(next);
  }, []);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<AuthErrorCode | null>(null);

  const login = useCallback(async (email: string, password: string): Promise<void> => {
    setIsLoading(true);
    setError(null);
    try {
      const state = await AuthService.login({ email, password });
      setAuthState(state);
    } catch (err) {
      setError(err instanceof AuthError ? err.code : 'LOGIN_FAILED');
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [setAuthState]);

  const loginWithSchoolAccount = useCallback(async (email: string): Promise<void> => {
    setIsLoading(true);
    setError(null);
    try {
      const state = await AuthService.loginWithSchoolAccount(email);
      setAuthState(state);
    } catch (err) {
      setError(err instanceof AuthError ? err.code : 'LOGIN_FAILED');
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [setAuthState]);

  const logout = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    try {
      await AuthService.logout();
      setAuthState(INITIAL_STATE);
    } finally {
      setIsLoading(false);
    }
  }, [setAuthState]);

  const restoreSession = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    try {
      const state = await AuthService.restoreSession();
      setAuthState(state);
    } catch (err) {
      // Session could not be restored — treat as signed-out. A session the
      // gate ended (the other app's role) says so on the login screen.
      setAuthState(INITIAL_STATE);
      if (err instanceof AuthError) setError(err.code);
    } finally {
      setIsLoading(false);
    }
  }, [setAuthState]);

  /** The profile as the school has it now (AuthService.recheckProfile); never blocks, never needs the network. */
  const recheckProfile = useCallback(async (current: AuthState): Promise<void> => {
    // Applied only to the state it checked: a logout, or the next person's
    // sign-in, while it waited is neither undone nor told the session expired.
    const unchanged = (): boolean => latest.current.teacherId === current.teacherId;
    try {
      const next = await AuthService.recheckProfile(current);
      if (next !== current && unchanged()) setAuthState(next);
    } catch (err) {
      if (!unchanged()) return;
      setAuthState(INITIAL_STATE);
      if (err instanceof AuthError) setError(err.code);
    }
  }, [setAuthState]);

  /** A session the server ended (AuthService.onSessionEnded): signed out, and the login screen says why. */
  const watchSessionEnd = useCallback(
    (): (() => void) =>
      AuthService.onSessionEnded(() => {
        setAuthState(INITIAL_STATE);
        setError('SESSION_EXPIRED');
      }),
    [setAuthState],
  );

  return { authState, isLoading, error, login, loginWithSchoolAccount, logout, restoreSession, recheckProfile, watchSessionEnd };
}
