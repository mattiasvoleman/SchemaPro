/**
 * Skolans kalender (P4): a whole calendar of lov written in one call, against a real database, as the API role under row
 * security, through the real SchoolBreaksService.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=2' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-skolans-kalender.ts
 *
 * The jest spec holds the rules with the database faked; this is what the adapter and the policies make of them: the
 * DATE columns the rows are written to, the `count` and the `deleteMany` that must agree on a lesson, the lesson a
 * lov leaves (one that is cancelled, one that has begun), the transaction that is all or nothing, and the table's own
 * policy that refuses a teacher. In a school of its own (<tag>-kalender), removed whole before and after.
 *
 *   (ka) THE DRY RUN COUNTS WHAT THE WRITE THEN TAKES, TO THE LESSON, and writes nothing: a whole-school week over
 *        four lessons, one of them cancelled and one that had begun, takes the other two; the dry run said two and
 *        left all lessons and no lov, and the write says two, makes the lov and leaves the other two;
 *   (kb) A LIST WITH ONE ROW OUTSIDE THE LÄSÅR WRITES NONE, and names the row: the first row, good, is not there after;
 *   (kc) THE SAME LIST AGAIN IS UNCHANGED: no lov made twice, no lesson taken (a lesson put back into the lov meanwhile
 *        is the proof: it stays);
 *   (kd) A WEEK FOR SOME ÅRSKURSER takes the lessons of those groups and not the others, counted the same way;
 *   (ke) A ROW WITH AN ID MOVES THAT LOV, and the lessons of its new days go; an id of another school's lov is a 404;
 *   (kf) A TEACHER IS REFUSED BY THE TABLE: nothing is written, and the dry run for them counts nothing either.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { createPgAdapter } from '../../src/database/pool-config';
import { PrismaService } from '../../src/database/prisma.service';
import { SchoolBreaksService } from '../../src/resources/school-breaks.service';

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

const TZ = 'Europe/Stockholm';
const day = (iso: string, by: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);

async function rejection(body: () => Promise<unknown>): Promise<{ status?: number; message: string }> {
  try {
    await body();
  } catch (error) {
    const status = (error as { getStatus?: () => number }).getStatus?.();
    return { ...(status === undefined ? {} : { status }), message: error instanceof Error ? error.message : String(error) };
  }
  throw new Error('Expected a refusal, got an answer.');
}

async function main(): Promise<void> {
  const owner = new PrismaClient({ adapter: createPgAdapter(requiredEnv('PROBE_OWNER_URL')) });
  const previous = process.env['DATABASE_URL'];
  const api = new PrismaService();
  process.env['DATABASE_URL'] = previous;
  const slug = `${randomUUID().slice(0, 8)}-kalender`;
  const sweep = () => owner.$executeRaw`DELETE FROM "Schools" WHERE slug LIKE '%-kalender'`;
  await sweep();
  try {
    await checks(owner, api, slug);
  } finally {
    await sweep().catch((error) => console.error('cleanup:', error));
    await api.$disconnect();
    await owner.$disconnect();
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nskolans-kalender probe passed.');
}

async function checks(owner: PrismaClient, api: PrismaService, slug: string): Promise<void> {
  const local = async (iso: string, hhmm: string): Promise<Date> => {
    const [row] = await owner.$queryRaw<Array<{ t: Date }>>`SELECT (${iso}::date + ${hhmm}::time) AT TIME ZONE ${TZ} AS t`;
    return row!.t;
  };
  const school = await owner.school.create({ data: { name: 'Kalenderprob', slug, timezone: TZ } });
  const s = school.id;
  const [{ today }] = await owner.$queryRaw<Array<{ today: Date }>>`SELECT (now() AT TIME ZONE ${TZ})::date AS today`;
  const todayIso = today!.toISOString().slice(0, 10);
  const year = await owner.academicYear.create({
    data: { schoolId: s, name: 'Kalender', startDate: new Date(`${day(todayIso, -100)}T00:00:00Z`), endDate: new Date(`${day(todayIso, 200)}T00:00:00Z`), isActive: true, gradeNumbering: 'NIOARIG' },
  });
  const klass = (name: string, gradeLevel: number) => owner.studentGroup.create({ data: { schoolId: s, academicYearId: year.id, name, kind: 'CLASS', gradeLevel } });
  const [g7, g9] = [await klass('7A', 7), await klass('9A', 9)];
  const subject = await owner.subject.create({ data: { schoolId: s, name: 'Matematik' } });
  const person = (role: 'SCHOOL_ADMIN' | 'TEACHER', key: string) =>
    owner.user.create({ data: { schoolId: s, authId: randomUUID(), role, firstName: key, lastName: 'Probe', email: `${key}@${slug}.test`, ...(role === 'SCHOOL_ADMIN' ? { adminProfile: 'FULL' as const } : {}) } });
  const [admin, teacher] = [await person('SCHOOL_ADMIN', 'admin'), await person('TEACHER', 'teacher')];
  const as = (user: { id: string; authId: string }, role: Role): AuthenticatedUser => ({
    authId: user.authId, role, userId: user.id, schoolId: s, ...(role === Role.SCHOOL_ADMIN ? { adminProfile: 'FULL' as const } : {}),
  });
  const asAdmin = as(admin, Role.SCHOOL_ADMIN);
  const asTeacher = as(teacher, Role.TEACHER);
  const service = new SchoolBreaksService(api);

  // The week the probe closes starts today, so that a lesson that has begun (00:00 today) is one of its days.
  const D = todayIso;
  const lesson = async (group: string, iso: string, extra: { status?: 'SCHEDULED' | 'CANCELLED'; begun?: boolean } = {}) =>
    owner.calendarLesson.create({
      data: {
        schoolId: s,
        subjectId: subject.id,
        studentGroupId: group,
        date: new Date(`${iso}T00:00:00Z`),
        startsAt: await local(iso, extra.begun ? '00:00' : '09:00'),
        endsAt: await local(iso, extra.begun ? '00:30' : '09:45'),
        ...(extra.status ? { status: extra.status } : {}),
      },
    });
  const lessonCount = () => owner.calendarLesson.count({ where: { schoolId: s } });
  const breakCount = () => owner.schoolBreak.count({ where: { schoolId: s } });
  const week = { name: 'Vecka X', startDate: D, endDate: day(D, 4) };

  await check('(ka) the dry run counts what the write then takes, to the lesson, and writes nothing', async () => {
    await lesson(g7.id, day(D, 1));
    await lesson(g9.id, day(D, 2));
    await lesson(g7.id, day(D, 3), { status: 'CANCELLED' });
    await lesson(g7.id, D, { begun: true });
    const before = await lessonCount();
    assert.equal(before, 4);
    const counted = await service.applyCalendar({ academicYearId: year.id, breaks: [week], dryRun: true }, asAdmin);
    assert.deepEqual([counted.dryRun, counted.created, counted.removedCalendarLessons, counted.items[0]!.id], [true, 1, 2, null]);
    assert.equal(await lessonCount(), before, 'the dry run took no lesson');
    assert.equal(await breakCount(), 0, 'the dry run made no lov');
    const written = await service.applyCalendar({ academicYearId: year.id, breaks: [week] }, asAdmin);
    assert.deepEqual([written.dryRun, written.created, written.removedCalendarLessons], [false, 1, 2]);
    assert.equal(await lessonCount(), 2, 'the cancelled lesson and the one that had begun are the ones left');
    assert.equal(await breakCount(), 1);
    const [row] = await owner.schoolBreak.findMany({ where: { schoolId: s } });
    assert.equal(row!.startDate.toISOString().slice(0, 10), D);
    assert.equal(row!.endDate.toISOString().slice(0, 10), day(D, 4));
  });

  await check('(kb) a list with one row outside the läsår writes none, and names the row', async () => {
    const lovBefore = await breakCount();
    const refusal = await rejection(() =>
      service.applyCalendar(
        { academicYearId: year.id, breaks: [{ name: 'Bra', startDate: day(D, 30), endDate: day(D, 31) }, { name: 'Efter året', startDate: day(todayIso, 150), endDate: day(todayIso, 400) }] },
        asAdmin,
      ),
    );
    assert.equal(refusal.status, 400);
    assert.match(refusal.message, /breaks\[1\]: endDate must fall inside the academic year/);
    assert.equal(await breakCount(), lovBefore, 'the first row, which was fine, is not there either');
  });

  await check('(kc) the same list again is unchanged: no lov made twice, and a lesson put back is not taken', async () => {
    const back = await lesson(g7.id, day(D, 2));
    const again = await service.applyCalendar({ academicYearId: year.id, breaks: [week, { ...week, name: 'VECKA X' }] }, asAdmin);
    assert.deepEqual([again.created, again.updated, again.unchanged, again.removedCalendarLessons], [0, 0, 2, 0]);
    assert.equal(await breakCount(), 1);
    assert.ok(await owner.calendarLesson.findUnique({ where: { id: back.id } }), 'the lesson stays: nothing was written, so nothing is taken');
    await owner.calendarLesson.delete({ where: { id: back.id } });
  });

  await check('(kd) a week for some årskurser takes the lessons of those groups, counted the same way', async () => {
    const start = day(D, 14);
    await lesson(g7.id, day(start, 1));
    await lesson(g9.id, day(start, 1));
    await lesson(g9.id, day(start, 2));
    const prao = { name: 'Prao åk 9', startDate: start, endDate: day(start, 4), minGradeLevel: 9, maxGradeLevel: 9 };
    const counted = await service.applyCalendar({ academicYearId: year.id, breaks: [prao], dryRun: true }, asAdmin);
    assert.equal(counted.removedCalendarLessons, 2);
    const written = await service.applyCalendar({ academicYearId: year.id, breaks: [prao] }, asAdmin);
    assert.equal(written.removedCalendarLessons, 2);
    const left = await owner.calendarLesson.findMany({ where: { schoolId: s, date: { gte: new Date(`${start}T00:00:00Z`) } } });
    assert.deepEqual(left.map((row) => row.studentGroupId), [g7.id]);
  });

  await check('(ke) a row with an id moves that lov and takes the lessons of its new days; an id that is not the year\'s is a 404', async () => {
    const [row] = await owner.schoolBreak.findMany({ where: { schoolId: s, name: 'Vecka X' } });
    const moved = { id: row!.id, name: 'Vecka X', startDate: day(D, 20), endDate: day(D, 24) };
    await lesson(g7.id, day(D, 21));
    const result = await service.applyCalendar({ academicYearId: year.id, breaks: [moved] }, asAdmin);
    assert.deepEqual([result.updated, result.created, result.removedCalendarLessons], [1, 0, 1]);
    const after = await owner.schoolBreak.findUniqueOrThrow({ where: { id: row!.id } });
    assert.equal(after.startDate.toISOString().slice(0, 10), day(D, 20));
    const missing = await rejection(() => service.applyCalendar({ academicYearId: year.id, breaks: [{ ...moved, id: randomUUID() }] }, asAdmin));
    assert.equal(missing.status, 404);
  });

  await check('(kf) a teacher is refused by the table: nothing is written, and the count says nothing about lessons', async () => {
    const lovBefore = await breakCount();
    await lesson(g7.id, day(D, 41));
    const refusal = await rejection(() => service.applyCalendar({ academicYearId: year.id, breaks: [{ name: 'Lärarens lov', startDate: day(D, 40), endDate: day(D, 44) }] }, asTeacher));
    assert.ok(refusal.message.length > 0);
    assert.equal(await breakCount(), lovBefore);
    assert.ok((await lessonCount()) >= 1);
    const counted = await service.applyCalendar({ academicYearId: year.id, breaks: [{ name: 'Lärarens lov', startDate: day(D, 40), endDate: day(D, 44) }], dryRun: true }, asTeacher);
    assert.equal(counted.created, 1, 'the count is a read: it is not a promise the write will go');
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
