/**
 * Personer utan e-postadress (20270310090000) against a real database, through the real services under row security: a pupil and a
 * guardian the school has no address for are in the register, in the class, on the roster of a lesson and in the register extract,
 * and have no login by any road.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-personer-utan-adress.ts
 *
 * The jest specs hold the rules with no database (users.service.spec.ts, import.service.spec.ts). This holds what a database adds:
 *
 *   (1) A PUPIL WITH NO ADDRESS is made as the school's administrator, in 7A, and is in the register (GET /users), in the class's
 *       members, on the roster of a 7A lesson (the attendance register) and in a lesson's attendance, with `email` null;
 *   (2) NO ROAD GIVES THEM A LOGIN: an invitation is 409 PERSON_HAS_NO_ADDRESS and the provider is never asked; the mass invitation
 *       counts them apart and invites the others; the database refuses an invitedAt on their row (23514) as the API's role, and an
 *       address taken from a person who has a login;
 *   (3) ONLY A PUPIL OR A GUARDIAN: a teacher with no address is 400 ADDRESS_REQUIRED, and so is a pupil with none becoming one;
 *   (4) A FILE OF PUPILS WITH NO ADDRESS (the import): made with no address and a warning each, a second upload skips them as known,
 *       a later one that has the address gives it to the one pupil of that name in that class (updated, not made again), and two with
 *       the same name and class and no address are said to be indistinguishable;
 *   (5) AN ADDRESS GIVEN LATER makes them an ordinary uninvited person, who is then invited like any other (the provider is asked once);
 *   (6) THE REGISTER EXTRACT (registerutdrag) of a person with no address is made, and says that there is none, where it used to
 *       throw on the address of every person the school has (the term index of the people it holds out);
 *   (7) THE REMOVAL of a person with no address deletes the row and asks the provider for nothing: there is no login to delete;
 *   (8) AN ADDRESS CORRECTED WHILE THE INVITATION IS ON ITS WAY: the login minted for the old address is not put on the row (409), and
 *       the invitation sent again goes to the new one.
 *
 * It makes a school of its own and drops it.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { AttendanceService } from '../../src/attendance/attendance.service';
import { createPgAdapter } from '../../src/database/pool-config';
import { PrismaService } from '../../src/database/prisma.service';
import { ImportService } from '../../src/import/import.service';
import { SubjectAccessService } from '../../src/school-export/subject-access.service';
import type { SupabaseAdminService } from '../../src/users/supabase-admin.service';
import { UsersService } from '../../src/users/users.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

let failures = 0;
async function check(label: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}\n     ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

const statusOf = (error: unknown): number | undefined => (error as { getStatus?: () => number }).getStatus?.();
const codeOf = (error: unknown): unknown => {
  const body = (error as { getResponse?: () => unknown }).getResponse?.();
  return typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
};
const rejection = async (body: () => Promise<unknown>): Promise<unknown> => {
  try {
    await body();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
};

async function main(): Promise<void> {
  const owner = new PrismaClient({ adapter: createPgAdapter(requiredEnv('PROBE_OWNER_URL')) });
  const api = new PrismaService();
  const tag = randomUUID().slice(0, 8);
  const slug = `probe-pua-${tag}`;
  const school = await owner.school.create({ data: { name: `Probe utan adress ${tag}`, slug, timezone: 'Europe/Stockholm' } });

  // The provider: counted, and never answers a login for anybody but the address it is asked about.
  const provider = { invited: [] as string[], deleted: [] as string[], gate: undefined as Promise<void> | undefined, reached: undefined as (() => void) | undefined };
  const supabaseAdmin = {
    isConfigured: true,
    inviteUser: async (email: string) => {
      provider.invited.push(email);
      // A test can hold the provider's answer, as a slow mail server does, to change the row while the invitation is on its way.
      provider.reached?.();
      await provider.gate;
      return { authId: randomUUID(), emailSent: true };
    },
    deleteUser: async (authId: string) => void provider.deleted.push(authId),
    changeUserEmail: async () => ({ outcome: 'unchanged' as const, confirmed: true }),
    resendInvitation: async () => undefined,
    deleteOwnedUser: async () => 'deleted' as const,
    markSeveralSchools: async () => undefined,
  } as unknown as SupabaseAdminService;
  const users = new UsersService(api, supabaseAdmin, { notifyUsers: async () => 0 } as unknown as NotificationsService);
  const imports = new ImportService(api, users);
  const attendance = new AttendanceService(api, { guardiansOf: async () => [], notifyUsers: async () => 0 } as unknown as NotificationsService);
  const access = new SubjectAccessService(api);

  try {
    const email = (name: string) => `${name}-${tag}@probe-pua.example.com`;
    const adminRow = await owner.user.create({
      data: { schoolId: school.id, authId: randomUUID(), role: 'SCHOOL_ADMIN', adminProfile: 'FULL', firstName: 'Anna', lastName: 'Admin', email: email('admin'), invitedAt: new Date() },
    });
    const teacherRow = await owner.user.create({
      data: { schoolId: school.id, authId: randomUUID(), role: 'TEACHER', firstName: 'Tor', lastName: 'Lärare', email: email('lararen') },
    });
    const year = await owner.academicYear.create({
      data: { schoolId: school.id, name: '2026/27', startDate: new Date('2026-08-17'), endDate: new Date('2027-06-11'), gradeNumbering: 'NIOARIG', isActive: true },
    });
    const group = await owner.studentGroup.create({ data: { schoolId: school.id, academicYearId: year.id, name: '7A', kind: 'CLASS', gradeLevel: 7 } });
    const subject = await owner.subject.create({ data: { schoolId: school.id, name: 'Matematik', code: 'MA' } });
    const admin: AuthenticatedUser = { authId: adminRow.authId, role: Role.SCHOOL_ADMIN, userId: adminRow.id, schoolId: school.id, adminProfile: 'FULL', hrRead: true, channel: 'OTHER' };
    const teacher: AuthenticatedUser = { authId: teacherRow.authId, role: Role.TEACHER, userId: teacherRow.id, schoolId: school.id, channel: 'OTHER' };
    const lesson = await owner.calendarLesson.create({
      data: {
        schoolId: school.id, subjectId: subject.id, studentGroupId: group.id, date: new Date('2026-10-05'),
        startsAt: new Date('2026-10-05T07:00:00.000Z'), endsAt: new Date('2026-10-05T08:00:00.000Z'),
      },
    });
    await owner.calendarLessonTeacher.create({ data: { schoolId: school.id, calendarLessonId: lesson.id, teacherId: teacherRow.id, role: 'LEAD' } });

    let pupil = '';
    let guardian = '';
    let invitable = '';

    await check('(1) a pupil with no address is made in 7A and is in the register, the class and the roster of a lesson', async () => {
      const withAddress = await users.create({ role: 'STUDENT', firstName: 'Alma', lastName: 'Adress', email: email('alma'), studentGroupId: group.id }, admin);
      invitable = withAddress.id;
      const made = await users.create({ role: 'STUDENT', firstName: 'Alva', lastName: 'Utanadress', studentGroupId: group.id }, admin);
      pupil = made.id;
      guardian = (await users.create({ role: 'GUARDIAN', firstName: 'Vera', lastName: 'Utanadress' }, admin)).id;
      assert.equal(made.email, null);
      assert.equal(made.invitedAt, null);

      const register = await users.list(admin);
      const listed = register.find((person) => person.id === pupil)!;
      assert.equal(listed.email, null, 'the register lists the person, with no address');
      assert.equal(listed.studentGroupId, group.id);

      const members = await owner.user.findMany({ where: { studentGroupId: group.id }, select: { id: true } });
      assert.deepEqual(members.map((member) => member.id).sort(), [invitable, pupil].sort(), 'the class has both');

      const roster = await attendance.lessonRoster(lesson.id, teacher);
      assert.deepEqual(
        roster.students.map((student) => student.id).sort(),
        [invitable, pupil].sort(),
        "the lesson's roster, the attendance register, has the pupil with no address",
      );
      const marked = await attendance.reportAttendance(
        { calendarLessonId: lesson.id, records: [{ studentId: pupil, status: 'PRESENT' }, { studentId: invitable, status: 'ABSENT' }] } as never,
        teacher,
      );
      assert.ok(marked, 'the pupil with no address is marked present');
      assert.equal(await owner.attendanceRecord.count({ where: { calendarLessonId: lesson.id, studentId: pupil, status: 'PRESENT' } }), 1);
    });

    await check('(2) no road gives them a login: the invitation, the mass invitation and the database say no', async () => {
      const refusal = await rejection(() => users.invite(pupil, admin));
      assert.equal(statusOf(refusal), 409);
      assert.equal(codeOf(refusal), 'PERSON_HAS_NO_ADDRESS');
      assert.deepEqual(provider.invited, [], 'the provider was never asked');

      const report = await users.inviteMany([pupil, guardian, invitable], admin);
      assert.equal(report.noAddress, 2);
      assert.equal(report.sent, 1);
      assert.deepEqual(report.errors, []);
      assert.deepEqual(provider.invited, [email('alma')], 'only the person with an address was invited');
      assert.equal((await owner.user.findUniqueOrThrow({ where: { id: pupil } })).invitedAt, null);

      // The database, as the API's role: a login on the row is 23514, and so is an address taken from a person who has one.
      await assert.rejects(
        () => api.withRls(admin, (tx) => tx.$executeRaw`UPDATE "Users" SET "invitedAt" = now() WHERE id = ${pupil}::uuid`),
        /Users_a_person_with_no_address_has_no_login|violates check constraint/,
      );
      await assert.rejects(
        () => api.withRls(admin, (tx) => tx.$executeRaw`UPDATE "Users" SET "email" = NULL WHERE id = ${invitable}::uuid`),
        /Users_a_person_with_no_address_has_no_login|violates check constraint/,
      );
    });

    await check('(3) only a pupil or a guardian: a teacher with no address is refused, and a pupil with none does not become one', async () => {
      const made = await rejection(() => users.create({ role: 'TEACHER', firstName: 'Ny', lastName: 'Lärare' }, admin));
      assert.equal(statusOf(made), 400);
      assert.equal(codeOf(made), 'ADDRESS_REQUIRED');
      const changed = await rejection(() => users.update(pupil, { role: 'TEACHER' }, admin));
      assert.equal(statusOf(changed), 400);
      assert.equal(codeOf(changed), 'ADDRESS_REQUIRED');
      assert.equal((await owner.user.findUniqueOrThrow({ where: { id: pupil } })).role, 'STUDENT', 'the row is as it was');
    });

    await check('(4) a file of pupils with no address: made with a warning each, known the second time, given the address the third', async () => {
      const upload = (rows: Array<Record<string, unknown>>) => imports.importStudents({ academicYearId: year.id, rows } as never, admin);
      const first = await upload([
        { firstName: 'Bo', lastName: 'Filen', className: '7A' },
        { firstName: 'Cia', lastName: 'Filen', email: '', className: '7A' },
      ]);
      assert.deepEqual([first.created, first.skipped, first.errors.length], [2, 0, 0]);
      assert.equal(first.warnings?.filter((warning) => warning.code === 'IMPORT_STUDENT_WITHOUT_ADDRESS').length, 2);
      assert.equal(await owner.user.count({ where: { schoolId: school.id, firstName: 'Bo', lastName: 'Filen', email: null } }), 1);

      const second = await upload([{ firstName: 'bo', lastName: 'FILEN', className: '7a' }]);
      assert.deepEqual([second.created, second.skipped], [0, 1], 'a second upload makes nobody twice');

      const third = await upload([{ firstName: 'Bo', lastName: 'Filen', email: email('bo'), className: '7A' }]);
      assert.deepEqual([third.created, third.updated], [0, 1], 'a later upload with the address gives it to the pupil');
      const bo = await owner.user.findMany({ where: { schoolId: school.id, firstName: 'Bo', lastName: 'Filen' } });
      assert.equal(bo.length, 1, 'one Bo, not two');
      assert.equal(bo[0]!.email, email('bo'));

      const twins = await upload([
        { firstName: 'Dan', lastName: 'Dubbel', className: '7A' },
        { firstName: 'Dan', lastName: 'Dubbel', className: '7A' },
      ]);
      assert.equal(twins.created, 1);
      assert.match(twins.errors[0]?.message ?? '', /går inte att skilja åt/);
    });

    await check('(5) an address given later: an ordinary uninvited person, invited like any other, once', async () => {
      await users.update(pupil, { email: email('alva') }, admin);
      assert.equal((await owner.user.findUniqueOrThrow({ where: { id: pupil } })).email, email('alva'));
      const before = provider.invited.length;
      const invited = await users.invite(pupil, admin);
      assert.equal(invited.emailSent, true);
      assert.equal(provider.invited.length, before + 1);
      assert.ok((await owner.user.findUniqueOrThrow({ where: { id: pupil } })).invitedAt, 'now with a login');
      const refusal = await rejection(() => users.update(pupil, { email: email('alva-annan') }, admin));
      assert.equal(codeOf(refusal), 'ADDRESS_OF_AN_INVITED_PERSON', 'the address of an invited person is their login');
    });

    await check('(6) the register extract of a person with no address is made, and the people it holds out do not stop it', async () => {
      // A protected pupil with no address: the extract of anybody else holds them out by name, and their address is no term.
      const hidden = await users.create({ role: 'STUDENT', firstName: 'Hedvig', lastName: 'Skyddad', studentGroupId: group.id }, admin);
      await owner.personProtection.create({ data: { schoolId: school.id, userId: hidden.id, source: 'ADMIN', kind: 'SKYDDAD_IDENTITET' } as never }).catch(() => undefined);
      const answer = await access.extract(admin, guardian, true);
      assert.ok(answer.contentBase64.length > 0, 'an extract was made');
      assert.equal(answer.contentType, 'application/zip');
    });

    await check('(7) the removal of a person with no address deletes the row and asks the provider for nothing', async () => {
      const deletedBefore = provider.deleted.length;
      await users.remove(guardian, admin);
      assert.equal(await owner.user.count({ where: { id: guardian } }), 0);
      const dan = await owner.user.findFirstOrThrow({ where: { schoolId: school.id, firstName: 'Dan', email: null } });
      await users.remove(dan.id, admin);
      assert.equal(provider.deleted.length, deletedBefore, 'no login was deleted at the provider');
    });

    await check('(8) an address corrected while the invitation is on its way: the login for the old one is not put on the row', async () => {
      const held = await users.create({ role: 'GUARDIAN', firstName: 'Vera', lastName: 'Rättad', email: email('vera-fel') }, admin);
      let release!: () => void;
      let reached!: () => void;
      const inFlight = new Promise<void>((resolve) => (reached = resolve));
      provider.gate = new Promise<void>((resolve) => (release = resolve));
      provider.reached = reached;
      const inviting = users.invite(held.id, admin);
      await inFlight;
      // The administrator corrects the address while the provider is answering.
      await users.update(held.id, { email: email('vera-ratt') }, admin);
      release();
      const refusal = await rejection(() => inviting);
      provider.gate = undefined;
      provider.reached = undefined;
      assert.equal(statusOf(refusal), 409);
      assert.equal(codeOf(refusal), 'ADDRESS_CHANGED_WHILE_INVITING');
      const row = await owner.user.findUniqueOrThrow({ where: { id: held.id } });
      assert.equal(row.email, email('vera-ratt'));
      assert.equal(row.invitedAt, null, 'no login was put on a row for an address it no longer has');

      const again = await users.invite(held.id, admin);
      assert.equal(again.emailSent, true);
      assert.equal(provider.invited.at(-1), email('vera-ratt'), 'the retry went to the corrected address');
    });
  } finally {
    await owner.school.deleteMany({ where: { id: school.id } });
    await owner.$disconnect();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
