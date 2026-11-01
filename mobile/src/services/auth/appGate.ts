import type { AppId } from '../../config/appIdentity';

/**
 * Which roles each app admits, and what the login screen says to anyone else.
 *
 * Users.role is one value per account (one Supabase identity, one Users row),
 * so a teacher who is also a parent has two accounts and signs in to each
 * app with its own. Every administrator profile (FULL, REKTOR,
 * SCHEMALAGGARE, EXPEDITION) is SCHOOL_ADMIN and is staff here, as it is in
 * the gateway's attendance route and in Settings.
 *
 * A role this build does not know (a future UserRole value) is admitted by
 * neither app: routing it to the staff shell, as the app did before the gate,
 * would hand it screens it may not be meant to see.
 */
export type AppRefusal = 'USE_GUARDIAN_APP' | 'USE_SCHOOL_APP' | 'ROLE_NOT_SUPPORTED' | 'APP_NOT_CONFIGURED';

const ADMITS: Readonly<Record<AppId, ReadonlySet<string>>> = {
  rastra: new Set(['TEACHER', 'SCHOOL_ADMIN', 'STUDENT']),
  vardnadshavare: new Set(['GUARDIAN']),
};

/** Null when `app` admits `role`; otherwise the code the login screen words. */
export function appRefusal(app: AppId | null, role: string): AppRefusal | null {
  if (app === null) return 'APP_NOT_CONFIGURED';
  if (ADMITS[app].has(role)) return null;
  if (ADMITS.vardnadshavare.has(role)) return 'USE_GUARDIAN_APP';
  if (ADMITS.rastra.has(role)) return 'USE_SCHOOL_APP';
  return 'ROLE_NOT_SUPPORTED';
}

/** Where an admitted role starts, and the Notiser tab a push opens (app/_layout.tsx). */
export function homeOf(role: string | null): { group: '(guardian)' | '(student)' | '(app)'; home: '/(guardian)/children' | '/(student)/schedule' | '/(app)/schedule'; notifications: '/(guardian)/notifications' | '/(student)/notifications' | '/(app)/notifications' } {
  if (role === 'GUARDIAN') return { group: '(guardian)', home: '/(guardian)/children', notifications: '/(guardian)/notifications' };
  if (role === 'STUDENT') return { group: '(student)', home: '/(student)/schedule', notifications: '/(student)/notifications' };
  return { group: '(app)', home: '/(app)/schedule', notifications: '/(app)/notifications' };
}

export function isAppRefusal(code: string): code is AppRefusal {
  return code === 'USE_GUARDIAN_APP' || code === 'USE_SCHOOL_APP' || code === 'ROLE_NOT_SUPPORTED' || code === 'APP_NOT_CONFIGURED';
}
