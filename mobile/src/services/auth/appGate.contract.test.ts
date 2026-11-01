import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRefusal } from './appGate';

/**
 * Every role the database can hold is admitted by exactly one of the two
 * apps. The enum is read from prisma/schema.prisma, as the gateway's
 * notification-types contract reads the app's files: a role added there
 * fails here, before a person with it meets a login screen that refuses
 * them in both apps. CI's mobile job checks out the whole repository.
 */
const SCHEMA = join(__dirname, '..', '..', '..', '..', 'prisma', 'schema.prisma');

function userRoles(): string[] {
  const block = /enum UserRole \{([^}]*)\}/.exec(readFileSync(SCHEMA, 'utf8'));
  if (!block) throw new Error('enum UserRole not found in prisma/schema.prisma');
  return block[1]!.split('\n').map((line) => line.replace(/\/\/.*$/, '').trim()).filter(Boolean);
}

it('admits every UserRole in exactly one app', () => {
  const roles = userRoles();
  expect(roles).toEqual(expect.arrayContaining(['STUDENT', 'TEACHER', 'SCHOOL_ADMIN', 'GUARDIAN']));
  for (const role of roles) {
    const admittedBy = (['rastra', 'vardnadshavare'] as const).filter((app) => appRefusal(app, role) === null);
    expect([role, admittedBy.length]).toEqual([role, 1]);
  }
});
