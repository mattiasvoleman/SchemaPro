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

  it('starts each admitted role in its own shell', () => {
    expect(homeOf('GUARDIAN').home).toBe('/(guardian)/children');
    expect(homeOf('STUDENT').home).toBe('/(student)/schedule');
    expect(homeOf('TEACHER').home).toBe('/(app)/schedule');
    expect(homeOf('SCHOOL_ADMIN').notifications).toBe('/(app)/notifications');
  });

  it('admits nobody in a build that does not say which app it is', () => {
    for (const role of ['TEACHER', 'SCHOOL_ADMIN', 'STUDENT', 'GUARDIAN']) expect(appRefusal(null, role)).toBe('APP_NOT_CONFIGURED');
  });
});
