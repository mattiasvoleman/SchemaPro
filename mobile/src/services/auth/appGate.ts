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
 *
 * An administrator who teaches (Users.teaches) is still a SCHOOL_ADMIN and
 * signs in to the same app as every administrator: the mark changes no app and
 * no start. It changes what the staff shell shows of Larm (alarmViews) and
 * nothing else (appTabs).
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

/** The two views of the Larm tab: the roll call of the person's own groups, and the administration's. */
export type AlarmView = 'ROLL_CALL' | 'MANAGEMENT';

/**
 * The views of the Larm tab a person has, the one it opens on first. A teacher
 * counts their own groups; an administrator starts the alarm, watches the
 * count and ends it; an administrator who teaches (Users.teaches) counts their
 * own groups FIRST, with a way to the administration's view (beslut 5 of the
 * investigation: the roll call before the management view), because the gateway
 * answers both and an alarm is when a teacher is wanted in the room. A student
 * and a guardian have none.
 *
 * Only a mark that is exactly true counts, and only on an administrator: the
 * database holds it on no one else.
 */
export function alarmViews(role: string | null, teaches: boolean): readonly AlarmView[] {
  if (role === 'TEACHER') return ['ROLL_CALL'];
  if (role === 'SCHOOL_ADMIN') return teaches === true ? ['ROLL_CALL', 'MANAGEMENT'] : ['MANAGEMENT'];
  return [];
}

/**
 * Whether the person counts their own groups at an alarm, and so has a roll call whose list the phone keeps
 * for the night the network is gone (services/crisisOffline.ts): a teacher, and an administrator who teaches.
 */
export function countsGroups(role: string | null, teaches: boolean): boolean {
  return alarmViews(role, teaches).includes('ROLL_CALL');
}

/**
 * Which of the staff shell's role-bound tabs a person has. Vikarie (cover
 * requests) is a teacher's alone: the gateway refuses every route of it to an
 * administrator, marked or not (SP409: an administrator is never in the
 * substitute pool or asked as a substitute), so the mark does not open it.
 * Larm is anyone's who has a view of an alarm. Schema, Närvaro, Notiser and
 * Inställningar are everyone's in the shell and are not decided here.
 */
export function appTabs(role: string | null, teaches: boolean): { readonly cover: boolean; readonly crisis: boolean } {
  return { cover: role === 'TEACHER', crisis: alarmViews(role, teaches).length > 0 };
}

/**
 * Where a push tap goes: the role's Notiser tab, the cover requests a teacher
 * is asked in, the roll call of an alarm, the messages a guardian is asked to
 * confirm, or the leave requests a guardian is asked to consent to.
 */
export type TapTarget =
  | ReturnType<typeof homeOf>['notifications']
  | '/(app)/cover-requests'
  | '/(app)/crisis'
  | '/(guardian)/acknowledgements'
  | '/(guardian)/leave';

/**
 * The notice types whose push is a question for a teacher (Vikariefrågan):
 * the question itself and its end, either of which is read in the Vikarie tab
 * where the card says what became of it. COVER_REQUEST_ACCEPTED is the
 * administrator's, and an inbox row like the rest.
 */
const COVER_QUESTION_TYPES: ReadonlySet<string> = new Set(['COVER_REQUESTED', 'COVER_REQUEST_CLOSED']);

/**
 * The notice types whose push is an alarm (Krisläge): that one is going and
 * that it is over. The staff who get them, the teacher who counts and the
 * administrator who started it and watches it, read them in the Larm tab. The
 * guardian's CRISIS_GUARDIAN_AFTER has no such tab and is an inbox row.
 */
const CRISIS_ALARM_TYPES: ReadonlySet<string> = new Set(['CRISIS_ALARM', 'CRISIS_ENDED']);

/**
 * The notice types that ask a guardian to confirm a message (Kvittens): the
 * request and its one reminder. Both are read, and answered, in the
 * guardian's Meddelanden tab.
 */
const ACK_TYPES: ReadonlySet<string> = new Set(['ACK_REQUESTED', 'ACK_REMINDER']);

/**
 * The Meddelanden tab, for a guardian and a notice that asks them to confirm
 * a message; null for anyone else and anything else. A push tap
 * (tapTarget) and a tap on the same notice in the Notiser tab both go here.
 */
export function ackTarget(role: string | null, type: string | null): '/(guardian)/acknowledgements' | null {
  return role === 'GUARDIAN' && type !== null && ACK_TYPES.has(type) ? '/(guardian)/acknowledgements' : null;
}

/**
 * The notice types of Ledighetspolicy for a guardian: a request for consent to
 * a leave request, its one reminder, and the end of a request a guardian did
 * not consent to (to whoever applied). All three are read in the guardian's
 * Ledighet tab, where the request is answered or its end is read.
 */
const LEAVE_CONSENT_TYPES: ReadonlySet<string> = new Set(['LEAVE_CONSENT_REQUESTED', 'LEAVE_CONSENT_REMINDER', 'LEAVE_CONSENT_REFUSED']);

/**
 * The Ledighet tab, for a guardian and a notice of Ledighetspolicy; null for
 * anyone else and anything else. A push tap (tapTarget) and a tap on the same
 * notice in the Notiser tab both go here.
 */
export function leaveConsentTarget(role: string | null, type: string | null): '/(guardian)/leave' | null {
  return role === 'GUARDIAN' && type !== null && LEAVE_CONSENT_TYPES.has(type) ? '/(guardian)/leave' : null;
}

/**
 * What a tap on a push opens. The type is what the gateway put in the push's
 * data (notification-delivery.service: { notificationId, type }); a tap that
 * carries none, or one the role has no screen for, opens the Notiser tab as
 * every tap did before. Only a TEACHER has the Vikarie tab (an administrator
 * who teaches has not: appTabs); both kinds of staff have Larm, and an
 * administrator who teaches finds the roll call of their own groups there
 * first (alarmViews), which is where an alarm push leads them; only a
 * GUARDIAN has Meddelanden, and Ledighet, where a request for consent to a
 * leave request is answered; and a student or a guardian never leaves their
 * own shell. A tap never opens a tab the person does not have.
 */
export function tapTarget(role: string | null, type: string | null, teaches: boolean = false): TapTarget {
  const messages = ackTarget(role, type);
  if (messages !== null) return messages;
  const leave = leaveConsentTarget(role, type);
  if (leave !== null) return leave;
  const tabs = appTabs(role, teaches);
  if (type !== null && tabs.crisis && CRISIS_ALARM_TYPES.has(type)) return '/(app)/crisis';
  if (type !== null && tabs.cover && COVER_QUESTION_TYPES.has(type)) return '/(app)/cover-requests';
  return homeOf(role).notifications;
}

/** The notice type in a notification response (expo-notifications), or null where the push carried none. */
export function tapTypeOf(response: unknown): string | null {
  const content = (response as { notification?: { request?: { content?: { data?: unknown } } } } | null | undefined)?.notification
    ?.request?.content;
  const type = (content?.data as { type?: unknown } | null | undefined)?.type;
  return typeof type === 'string' ? type : null;
}

export function isAppRefusal(code: string): code is AppRefusal {
  return code === 'USE_GUARDIAN_APP' || code === 'USE_SCHOOL_APP' || code === 'ROLE_NOT_SUPPORTED' || code === 'APP_NOT_CONFIGURED';
}
