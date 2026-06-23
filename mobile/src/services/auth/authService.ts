import { SecureTokenStore } from './secureTokenStore';
import type { AuthState } from '../../types';

// ─────────────────────────────────────────────────────────────────────────────
// API_BASE_URL is resolved from the environment at build time.
// It must NEVER be hardcoded here.
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE_URL = process.env['EXPO_PUBLIC_API_BASE_URL'];

interface LoginCredentials {
  readonly email: string;
  readonly password: string;
}

interface AuthTokenResponse {
  readonly accessToken: string;
  readonly teacherId: string;
  readonly role: string;
}

function resolveApiBase(): string {
  if (!API_BASE_URL) {
    throw new Error(
      '[AuthService] EXPO_PUBLIC_API_BASE_URL is not set. Check your .env.local file.',
    );
  }
  return API_BASE_URL;
}

async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    return typeof body['message'] === 'string' ? body['message'] : `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export const AuthService = {
  async login(credentials: LoginCredentials): Promise<AuthState> {
    const base = resolveApiBase();

    const response = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    });

    if (!response.ok) {
      const message = await parseErrorMessage(response);
      throw new Error(message);
    }

    const data = (await response.json()) as AuthTokenResponse;

    await Promise.all([
      SecureTokenStore.saveToken(data.accessToken),
      SecureTokenStore.saveTeacherSession(data.teacherId, data.role),
    ]);

    return {
      isAuthenticated: true,
      teacherId: data.teacherId,
      role: data.role,
    };
  },

  async restoreSession(): Promise<AuthState> {
    const [token, session] = await Promise.all([
      SecureTokenStore.getToken(),
      SecureTokenStore.getTeacherSession(),
    ]);

    if (!token || !session) {
      return { isAuthenticated: false, teacherId: null, role: null };
    }

    return {
      isAuthenticated: true,
      teacherId: session.teacherId,
      role: session.role,
    };
  },

  async logout(): Promise<void> {
    await SecureTokenStore.clearSession();
  },
} as const;
