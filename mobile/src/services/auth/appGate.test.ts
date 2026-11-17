import { ackTarget, alarmViews, appRefusal, appTabs, homeOf, leaveConsentTarget, tapTarget, tapTypeOf } from './appGate';

/**
 * Each app admits only its own roles, and tells everyone else which app is
 * theirs. Every UserRole value is listed, so a new one fails here first.
 */
describe('appRefusal', () => {
  it.each([
    // role,           Rastra,              Rastra vårdnadshavare
    ['TEACHER', null, 'USE_SCHOOL_APP'],
    ['SCHOOL_ADMIN', null, 'USE_SCHOOL_APP'],
    ['STUDENT', null, 'USE_SCHOOL_APP'],
    ['GUARDIAN', 'USE_GUARDIAN_APP', null],
    // Not a Users role (the gateway's platform operator has no row), and a value this build does not know.
    ['SYSTEM_ADMIN', 'ROLE_NOT_SUPPORTED', 'ROLE_NOT_SUPPORTED'],
    ['', 'ROLE_NOT_SUPPORTED', 'ROLE_NOT_SUPPORTED'],
  ])('%s: Rastra says %s, Rastra vårdnadshavare says %s', (role, rastra, vardnadshavare) => {
    expect(appRefusal('rastra', role)).toBe(rastra);
    expect(appRefusal('vardnadshavare', role)).toBe(vardnadshavare);
  });

  // app/_layout.tsx routes by this alone: AuthGate's group and start, PushBridge's Notiser tab.
  it.each([
    ['GUARDIAN', { group: '(guardian)', home: '/(guardian)/children', notifications: '/(guardian)/notifications' }],
    ['STUDENT', { group: '(student)', home: '/(student)/schedule', notifications: '/(student)/notifications' }],
    ['TEACHER', { group: '(app)', home: '/(app)/schedule', notifications: '/(app)/notifications' }],
    ['SCHOOL_ADMIN', { group: '(app)', home: '/(app)/schedule', notifications: '/(app)/notifications' }],
  ])('starts %s in its own shell', (role, shell) => {
    expect(homeOf(role)).toEqual(shell);
  });

  it('admits nobody in a build that does not say which app it is', () => {
    for (const role of ['TEACHER', 'SCHOOL_ADMIN', 'STUDENT', 'GUARDIAN']) expect(appRefusal(null, role)).toBe('APP_NOT_CONFIGURED');
  });
});

/**
 * A tap on a push opens the role's Notiser tab, except a cover question for a
 * teacher (Vikariefrågan), which opens the Vikarie tab where it is answered,
 * and an alarm (Krisläge), which opens the Larm tab of a teacher or an
 * administrator.
 */
describe('tapTarget', () => {
  it.each([
    ['TEACHER', 'COVER_REQUESTED', '/(app)/cover-requests'],
    ['TEACHER', 'COVER_REQUEST_CLOSED', '/(app)/cover-requests'],
    // The answer is the administrator's, and an inbox row like the rest.
    ['SCHOOL_ADMIN', 'COVER_REQUEST_ACCEPTED', '/(app)/notifications'],
    ['TEACHER', 'LESSON_SUBSTITUTE', '/(app)/notifications'],
    // Only a teacher has the tab: another role's tap never leaves its own shell.
    ['SCHOOL_ADMIN', 'COVER_REQUESTED', '/(app)/notifications'],
    ['STUDENT', 'COVER_REQUESTED', '/(student)/notifications'],
    ['GUARDIAN', 'COVER_REQUEST_CLOSED', '/(guardian)/notifications'],
    // A push from a gateway that sent no type, or a role not yet known.
    ['TEACHER', null, '/(app)/notifications'],
    [null, 'COVER_REQUESTED', '/(app)/notifications'],
  ])('%s tapping %s opens %s', (role, type, target) => {
    expect(tapTarget(role, type)).toBe(target);
  });

  // Krisläge: the push says only that an alarm is going or over, and the staff
  // who count and who watch both read it in the Larm tab.
  it.each([
    ['TEACHER', 'CRISIS_ALARM', '/(app)/crisis'],
    ['TEACHER', 'CRISIS_ENDED', '/(app)/crisis'],
    ['SCHOOL_ADMIN', 'CRISIS_ALARM', '/(app)/crisis'],
    ['SCHOOL_ADMIN', 'CRISIS_ENDED', '/(app)/crisis'],
    // A guardian's notice has no tab of its own: an inbox row, in whichever shell the person is in.
    ['GUARDIAN', 'CRISIS_GUARDIAN_AFTER', '/(guardian)/notifications'],
    ['TEACHER', 'CRISIS_GUARDIAN_AFTER', '/(app)/notifications'],
    // Only staff have the tab: another role's tap never leaves its own shell.
    ['STUDENT', 'CRISIS_ALARM', '/(student)/notifications'],
    ['GUARDIAN', 'CRISIS_ALARM', '/(guardian)/notifications'],
    [null, 'CRISIS_ALARM', '/(app)/notifications'],
    // A push without a type, from a gateway that sent none.
    ['TEACHER', null, '/(app)/notifications'],
  ])('%s tapping %s opens %s (Krisläge)', (role, type, target) => {
    expect(tapTarget(role, type)).toBe(target);
  });
});

/**
 * Kvittens: a message the school asks a guardian to confirm, and its one
 * reminder, are read and answered in the guardian's Meddelanden tab, from a
 * push and from the same notice in the Notiser tab.
 */
describe('tapTarget and ackTarget (Kvittens)', () => {
  it.each([
    ['GUARDIAN', 'ACK_REQUESTED', '/(guardian)/acknowledgements'],
    ['GUARDIAN', 'ACK_REMINDER', '/(guardian)/acknowledgements'],
    // Only a guardian has the tab: another role's tap never leaves its own shell.
    ['TEACHER', 'ACK_REQUESTED', '/(app)/notifications'],
    ['SCHOOL_ADMIN', 'ACK_REMINDER', '/(app)/notifications'],
    ['STUDENT', 'ACK_REQUESTED', '/(student)/notifications'],
    // Another guardian notice stays an inbox row.
    ['GUARDIAN', 'LEAVE_DECIDED', '/(guardian)/notifications'],
    ['GUARDIAN', 'CRISIS_GUARDIAN_AFTER', '/(guardian)/notifications'],
    // A push without a type, from a gateway that sent none.
    ['GUARDIAN', null, '/(guardian)/notifications'],
    [null, 'ACK_REQUESTED', '/(app)/notifications'],
  ])('%s tapping %s opens %s', (role, type, target) => {
    expect(tapTarget(role, type)).toBe(target);
  });

  it('names the Meddelanden tab only for a guardian and the two notice types', () => {
    expect(ackTarget('GUARDIAN', 'ACK_REQUESTED')).toBe('/(guardian)/acknowledgements');
    expect(ackTarget('GUARDIAN', 'ACK_REMINDER')).toBe('/(guardian)/acknowledgements');
    expect(ackTarget('GUARDIAN', 'COVER_REQUESTED')).toBeNull();
    expect(ackTarget('GUARDIAN', null)).toBeNull();
    expect(ackTarget('TEACHER', 'ACK_REQUESTED')).toBeNull();
    expect(ackTarget(null, 'ACK_REQUESTED')).toBeNull();
  });
});

/**
 * Ledighetspolicy: a request for a guardian's consent to a leave request, its
 * one reminder, and the end of a request a guardian did not consent to (to
 * whoever applied) are read in the guardian's Ledighet tab, from a push and
 * from the same notice in the Notiser tab.
 */
describe('tapTarget and leaveConsentTarget (Ledighetspolicy)', () => {
  it.each([
    ['GUARDIAN', 'LEAVE_CONSENT_REQUESTED', '/(guardian)/leave'],
    ['GUARDIAN', 'LEAVE_CONSENT_REMINDER', '/(guardian)/leave'],
    ['GUARDIAN', 'LEAVE_CONSENT_REFUSED', '/(guardian)/leave'],
    // Only a guardian has the tab to answer in: another role's tap never leaves its own shell.
    ['TEACHER', 'LEAVE_CONSENT_REQUESTED', '/(app)/notifications'],
    ['SCHOOL_ADMIN', 'LEAVE_CONSENT_REFUSED', '/(app)/notifications'],
    ['STUDENT', 'LEAVE_CONSENT_REMINDER', '/(student)/notifications'],
    // The decision of a request is an inbox row, as it was, and so is the mentor's own LEAVE_REQUESTED.
    ['GUARDIAN', 'LEAVE_DECIDED', '/(guardian)/notifications'],
    ['TEACHER', 'LEAVE_REQUESTED', '/(app)/notifications'],
    // Kvittens keeps its own tab.
    ['GUARDIAN', 'ACK_REQUESTED', '/(guardian)/acknowledgements'],
    // A push without a type, from a gateway that sent none, or a role not yet known.
    ['GUARDIAN', null, '/(guardian)/notifications'],
    [null, 'LEAVE_CONSENT_REQUESTED', '/(app)/notifications'],
  ])('%s tapping %s opens %s', (role, type, target) => {
    expect(tapTarget(role, type)).toBe(target);
  });

  it('names the Ledighet tab only for a guardian and the three notice types', () => {
    for (const type of ['LEAVE_CONSENT_REQUESTED', 'LEAVE_CONSENT_REMINDER', 'LEAVE_CONSENT_REFUSED']) {
      expect(leaveConsentTarget('GUARDIAN', type)).toBe('/(guardian)/leave');
      expect(leaveConsentTarget('TEACHER', type)).toBeNull();
      expect(leaveConsentTarget('SCHOOL_ADMIN', type)).toBeNull();
      expect(leaveConsentTarget('STUDENT', type)).toBeNull();
      expect(leaveConsentTarget(null, type)).toBeNull();
    }
    expect(leaveConsentTarget('GUARDIAN', 'LEAVE_DECIDED')).toBeNull();
    expect(leaveConsentTarget('GUARDIAN', 'ACK_REQUESTED')).toBeNull();
    expect(leaveConsentTarget('GUARDIAN', null)).toBeNull();
  });

  it('leaves Kvittens’ own target alone for the notices of Ledighetspolicy', () => {
    expect(ackTarget('GUARDIAN', 'LEAVE_CONSENT_REQUESTED')).toBeNull();
    expect(leaveConsentTarget('GUARDIAN', 'ACK_REQUESTED')).toBeNull();
  });
});

describe('tapTypeOf', () => {
  it('reads the notice type the gateway put in the push', () => {
    const response = { notification: { request: { content: { data: { notificationId: 'n-1', type: 'COVER_REQUESTED' } } } } };
    expect(tapTypeOf(response)).toBe('COVER_REQUESTED');
  });

  it.each([
    ['no response', undefined],
    ['null', null],
    ['an empty response', {}],
    ['a push without data', { notification: { request: { content: {} } } }],
    ['data that is not an object', { notification: { request: { content: { data: 'x' } } } }],
    ['a type that is not a string', { notification: { request: { content: { data: { type: 7 } } } } }],
  ])('says none for %s', (_name, response) => {
    expect(tapTypeOf(response)).toBeNull();
  });
});

/**
 * Administratör som lärare (Users.teaches, PR 6 av 7). The mark that an
 * administrator teaches adds one thing to the app: Larm opens on the roll call
 * of the person's own groups, with the administration's view one tap away.
 * It changes no app, no start and no other tab: Vikarie stays a teacher's
 * (the gateway refuses every cover route to an administrator, SP409).
 */
describe('alarmViews: what Larm shows each person, the one it opens on first', () => {
  it.each([
    // role, teaches, views
    ['TEACHER', false, ['ROLL_CALL']],
    ['SCHOOL_ADMIN', false, ['MANAGEMENT']],
    // The marked administrator: her own groups first, then the administration's view.
    ['SCHOOL_ADMIN', true, ['ROLL_CALL', 'MANAGEMENT']],
    ['STUDENT', false, []],
    ['GUARDIAN', false, []],
    [null, false, []],
    ['SYSTEM_ADMIN', false, []],
  ] as const)('%s (teaches: %s) has %j', (role, teaches, views) => {
    expect(alarmViews(role, teaches)).toEqual(views);
  });

  // The database holds the mark on an administrator alone (a CHECK, a trigger that zeroes it). A phone that was handed one
  // anywhere else would be wrong, not generous: the mark counts for nothing but on an administrator.
  it.each(['TEACHER', 'STUDENT', 'GUARDIAN', 'SYSTEM_ADMIN', ''])('gives the mark on %s no second view', (role) => {
    expect(alarmViews(role, true)).toEqual(alarmViews(role, false));
  });

  it('reads only a mark that is exactly true', () => {
    for (const odd of [undefined, null, 'true', 1, {}]) {
      expect(alarmViews('SCHOOL_ADMIN', odd as unknown as boolean)).toEqual(['MANAGEMENT']);
    }
  });
});

describe('appTabs: the role-bound tabs of the staff shell', () => {
  it.each([
    // role, teaches, Vikarie, Larm
    ['TEACHER', false, true, true],
    ['SCHOOL_ADMIN', false, false, true],
    // The mark opens no Vikarie tab: SP409 keeps an administrator out of the substitute pool and the question.
    ['SCHOOL_ADMIN', true, false, true],
    ['STUDENT', false, false, false],
    ['GUARDIAN', false, false, false],
    [null, false, false, false],
  ] as const)('%s (teaches: %s): Vikarie %s, Larm %s', (role, teaches, cover, crisis) => {
    expect(appTabs(role, teaches)).toEqual({ cover, crisis });
  });
});

describe('tapTarget for an administrator who teaches', () => {
  it.each([
    ['CRISIS_ALARM', '/(app)/crisis'],
    ['CRISIS_ENDED', '/(app)/crisis'],
    // Larm is where the roll call of her own groups is, first: the push leads there.
    // The cover question is a teacher's: she is never asked it, and a tap never opens a tab she has not got.
    ['COVER_REQUESTED', '/(app)/notifications'],
    ['COVER_REQUEST_CLOSED', '/(app)/notifications'],
    ['COVER_REQUEST_ACCEPTED', '/(app)/notifications'],
    ['LESSON_SUBSTITUTE', '/(app)/notifications'],
    // The mentor's notice has no link for anyone (as on the web), and the guardian's notices are not hers.
    ['LEAVE_REQUESTED', '/(app)/notifications'],
    ['LEAVE_CONSENT_REQUESTED', '/(app)/notifications'],
    ['ACK_REQUESTED', '/(app)/notifications'],
    [null, '/(app)/notifications'],
  ])('%s opens %s', (type, target) => {
    expect(tapTarget('SCHOOL_ADMIN', type, true)).toBe(target);
  });

  it('leaves every other persona’s taps as they were, marked or not', () => {
    for (const type of ['CRISIS_ALARM', 'CRISIS_ENDED', 'COVER_REQUESTED', 'COVER_REQUEST_CLOSED', 'LESSON_SUBSTITUTE', 'ACK_REQUESTED', 'LEAVE_CONSENT_REQUESTED', null]) {
      for (const role of ['TEACHER', 'SCHOOL_ADMIN', 'STUDENT', 'GUARDIAN', null]) {
        // A tap that says nothing of the mark (every call before it) is an unmarked person's.
        expect(tapTarget(role, type, false)).toBe(tapTarget(role, type));
      }
      for (const role of ['TEACHER', 'STUDENT', 'GUARDIAN', null]) expect(tapTarget(role, type, true)).toBe(tapTarget(role, type, false));
    }
  });

  it('does not change where the marked administrator starts, or which app admits her', () => {
    expect(homeOf('SCHOOL_ADMIN')).toEqual({ group: '(app)', home: '/(app)/schedule', notifications: '/(app)/notifications' });
    expect(appRefusal('rastra', 'SCHOOL_ADMIN')).toBeNull();
    expect(appRefusal('vardnadshavare', 'SCHOOL_ADMIN')).toBe('USE_SCHOOL_APP');
  });
});
