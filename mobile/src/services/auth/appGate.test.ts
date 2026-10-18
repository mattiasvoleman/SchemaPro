import { appRefusal, homeOf } from './appGate';

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
