import { appRefusal, homeOf, tapTarget, tapTypeOf } from './appGate';

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
