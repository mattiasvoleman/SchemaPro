import { useCallback, useState } from 'react';
import { AuthService } from '../services/auth/authService';
import type { AuthState } from '../types';

interface UseSecureAuthReturn {
  readonly authState: AuthState;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly login: (email: string, password: string) => Promise<void>;
  readonly logout: () => Promise<void>;
  readonly restoreSession: () => Promise<void>;
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
  const [authState, setAuthState] = useState<AuthState>(INITIAL_STATE);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async (email: string, password: string): Promise<void> => {
    setIsLoading(true);
    setError(null);
    try {
      const state = await AuthService.login({ email, password });
      setAuthState(state);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      setError(message);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    try {
      await AuthService.logout();
      setAuthState(INITIAL_STATE);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const restoreSession = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    try {
      const state = await AuthService.restoreSession();
      setAuthState(state);
    } catch {
      // Session could not be restored — treat as signed-out.
      setAuthState(INITIAL_STATE);
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { authState, isLoading, error, login, logout, restoreSession };
}
