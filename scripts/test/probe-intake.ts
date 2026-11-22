/**
 * Vad kom in against a real database, as the API role under RLS, through the real service (P1 Pilotkit, part 2).
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=2' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-intake.ts
 *
 * The jest specs hold the rules (src/intake/intake.spec.ts) and the route's gates (test/intake.e2e-spec.ts) with the
 * database faked. This is what they cannot see: that each count is the count of the rows it says, that a class with every
 * lesson in a group is not "without a post", and that another school's rows are never counted.
 *
 *   (a) AN EMPTY SCHOOL: the year, the subjects, the rooms and the teachers are what is missing, and nothing waits on a year
 *       that is not there;
 *   (b) A SCHOOL WITH A LITTLE OF EVERYTHING, each count against the rows the probe made: a class whose lessons are all
 *       in a teaching group is not without a post, nor a class whose half has one; a class with no årskurs, an empty
 *       teaching group, a post with no teacher, a subject with no post and a subject that asks for a room type no room has
 *       are each found by name; a teacher, a teaching administrator, a deactivated teacher and a teacher with no post are
 *       counted as what they are; the posts and their signatures are counted and never read;
 *   (c) the school's choice about a post with no teacher (Vägra) turns that gap hard, and a room of the missing type
 *       takes the room-type gap away;
 *   (d) ANOTHER SCHOOL'S ROWS are never counted;
 *   (e) a läsare reads the same as a full administrator, the rows of a läsår that is not the active one are never counted, and a
 *       school with no active läsår waits for it;
 *   (f) A TIOARIG LÄSÅR is held against the frames in NIOARIG: its åk 8 is covered by a frame for 7;
 *   (g) the answer holds no person: nothing in it is an address, a name of a person or a percentage.
 *
 * It builds its own schools and drops them, and counts on no number the seed or an earlier CI step left. The demo school is
 * not read.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { createPgAdapter } from '../../src/database/pool-config';
import { PrismaService } from '../../src/database/prisma.service';
import type { IntakeGapCode, IntakeView } from '../../src/intake/intake';
import { IntakeService } from '../../src/intake/intake.service';

type Owner = PrismaClient;

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

const time = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);

async function adminOf(owner: Owner, schoolId: string, profile: 'FULL' | 'LASARE' = 'FULL'): Promise<AuthenticatedUser> {
  const row = await owner.user.findFirst({
    where: { schoolId, role: 'SCHOOL_ADMIN', isActive: true, adminProfile: profile },
    orderBy: { email: 'asc' },
  });
  assert.ok(row, `an active ${profile} administrator at ${schoolId}`);
  return { authId: row.authId, role: Role.SCHOOL_ADMIN, userId: row.id, schoolId, adminProfile: profile, hrRead: row.hrRead, channel: 'OTHER' };
}

const gaps = (view: IntakeView) => view.areas.flatMap((area) => area.gaps);
const gap = (view: IntakeView, code: IntakeGapCode) => {
  const found = gaps(view).find((entry) => entry.code === code);
  assert.ok(found, `the gap ${code}`);
  return found;
};
const found = (view: IntakeView, area: string) => view.areas.find((entry) => entry.area === area)!.found;
const present = (view: IntakeView) => gaps(view).filter((entry) => entry.count > 0).map((entry) => entry.code);

interface Built {
  schoolId: string;
  yearId: string;
  admin: AuthenticatedUser;
  lasare: AuthenticatedUser;
}

async function newSchool(owner: Owner, tag: string, label: string, cleanup: Array<() => Promise<void>>): Promise<{ schoolId: string }> {
  const school = await owner.school.create({ data: { name: `Probe vad kom in ${label} ${tag}`, slug: `probe-intake-${label}-${tag}`, timezone: 'Europe/Stockholm' } });
  cleanup.push(async () => {
    await owner.school.delete({ where: { id: school.id } });
  });
  await owner.user.create({
    data: { schoolId: school.id, authId: randomUUID(), role: 'SCHOOL_ADMIN', adminProfile: 'FULL', firstName: 'Ada', lastName: 'Admin', email: `admin-${label}-${tag}@probe.example.com` },
  });
  await owner.user.create({
    data: { schoolId: school.id, authId: randomUUID(), role: 'SCHOOL_ADMIN', adminProfile: 'LASARE', firstName: 'Lars', lastName: 'Läsare', email: `lasare-${label}-${tag}@probe.example.com` },
  });
  return { schoolId: school.id };
}

/** A school with a little of everything: what each count is counted against is written beside the rows. */
async function buildSchool(owner: Owner, tag: string, cleanup: Array<() => Promise<void>>): Promise<Built> {
  const { schoolId } = await newSchool(owner, tag, 'skolan', cleanup);
  const yearId = (
    await owner.academicYear.create({ data: { schoolId, name: '2026/2027', startDate: new Date('2026-08-17'), endDate: new Date('2027-06-11'), gradeNumbering: 'NIOARIG', isActive: true } })
  ).id;

  // People. Teachers: T1, T2 and T5 with a post (T2 and T5 have no signature), T3 with none, T4 deactivated, and an administrator
  // who teaches.
  const person = (key: string, role: 'TEACHER' | 'STUDENT', extra: Record<string, unknown> = {}) =>
    owner.user.create({ data: { schoolId, authId: randomUUID(), role, firstName: key, lastName: 'Probe', email: `${key.toLowerCase()}-${tag}@probe.example.com`, ...extra } });
  const t1 = await person('T1', 'TEACHER');
  const t2 = await person('T2', 'TEACHER');
  const t5 = await person('T5', 'TEACHER');
  await person('T3', 'TEACHER');
  await person('T4', 'TEACHER', { isActive: false });
  const post = (userId: string, signature: string | null) =>
    owner.teacherEmployment.create({ data: { schoolId, userId, academicYearId: yearId, employmentPercent: 100, signature } });
  await post(t1.id, 'ABE');
  await post(t2.id, null);
  await post(t5.id, null);
  const teachingAdmin = await owner.user.create({
    data: { schoolId, authId: randomUUID(), role: 'SCHOOL_ADMIN', adminProfile: 'FULL', firstName: 'Zed', lastName: 'Undervisar', email: `zz-undervisar-${tag}@probe.example.com` },
  });
  await post(teachingAdmin.id, 'ZED');
  await owner.user.update({ where: { id: teachingAdmin.id }, data: { teaches: true } });

  // The room types: Textilslöjd has no room, Klassrum has.
  const klassrum = await owner.roomType.create({ data: { schoolId, name: 'Klassrum' } });
  const textil = await owner.roomType.create({ data: { schoolId, name: 'Textilslöjd' } });
  await owner.room.create({ data: { schoolId, name: 'A101', capacity: 30, roomTypeId: klassrum.id } });
  await owner.room.create({ data: { schoolId, name: 'A102', capacity: 30 } });

  const subject: Record<string, string> = {};
  for (const [name, code, requiredRoomTypeId] of [
    ['Matematik', 'MA', null],
    ['Svenska', 'SV', null],
    ['Slöjd', 'SL', textil.id],
    ['Teknik', 'TK', null],
  ] as const) {
    subject[name] = (await owner.subject.create({ data: { schoolId, name, code, requiredRoomTypeId } })).id;
  }

  // The groups. 7A has a post of its own. 7B has none of its own, and its pupil sits in Ma7, which has one. 8A and 8B have none
  // and no pupil in a group with one. 9A has none of its own, but its half 9A-1 has, and a pupil of the class is in it. 9B has none
  // of its own and no pupil in its half 9B-1, which has one: only the half reaches it. Förb has no årskurs and no post.
  const group: Record<string, string> = {};
  const makeGroup = async (name: string, kind: 'CLASS' | 'TEACHING_GROUP', gradeLevel: number | null, halfOf?: string) => {
    group[name] = (await owner.studentGroup.create({ data: { schoolId, academicYearId: yearId, name, kind, gradeLevel, ...(halfOf ? { halfOfId: group[halfOf]! } : {}) } })).id;
  };
  for (const [name, grade] of [['7A', 7], ['7B', 7], ['8A', 8], ['8B', 8], ['9A', 9], ['9B', 9], ['Förb', null]] as const) await makeGroup(name, 'CLASS', grade);
  await makeGroup('Ma7', 'TEACHING_GROUP', null);
  await makeGroup('9A-1', 'TEACHING_GROUP', 9, '9A');
  await makeGroup('9B-1', 'TEACHING_GROUP', 9, '9B');
  await makeGroup('En8', 'TEACHING_GROUP', null);

  // Pupils: four in a class (one of them in Ma7 from 7B, one in the half 9A-1), one with no class, one deactivated with none.
  const pupil = async (key: string, cls: string | null, extra: Record<string, unknown> = {}) =>
    person(key, 'STUDENT', { studentGroupId: cls === null ? null : group[cls]!, ...extra });
  const s1 = await pupil('S1', '7A');
  const s2 = await pupil('S2', '7B');
  const s3 = await pupil('S3', '9A');
  await pupil('S4', '8A');
  await pupil('S5', null);
  await pupil('S6', null, { isActive: false });
  for (const [groupName, studentId] of [['Ma7', s2.id], ['Ma7', s1.id], ['9A-1', s3.id]] as const) {
    await owner.studentGroupMember.create({ data: { schoolId, studentGroupId: group[groupName]!, studentId } });
  }

  // The posts. Slöjd's has no teacher and asks for Textilslöjd, which no room is.
  const requirement = (g: string, s: string, teacherId: string | null) =>
    owner.teachingRequirement.create({ data: { schoolId, academicYearId: yearId, studentGroupId: group[g]!, subjectId: subject[s]!, teacherId, lessonsPerWeek: 2, minutesPerLesson: 60 } });
  await requirement('7A', 'Matematik', t1.id);
  await requirement('7A', 'Slöjd', null);
  await requirement('Ma7', 'Svenska', t2.id);
  await requirement('9A-1', 'Matematik', t1.id);
  await requirement('9B-1', 'Svenska', t2.id);

  // The frame times: a frame for åk 7 and 8, so åk 9 has none. No rast at all.
  await owner.frameTime.create({ data: { schoolId, minGradeLevel: 7, maxGradeLevel: 8, startTime: time('08:00'), endTime: time('16:00') } });

  // The lokal timplan: decided for åk 7, a draft for åk 8, none for åk 9.
  const version = await owner.nationalTimplanVersion.findFirst({ where: { schoolForm: 'GRUNDSKOLA' } });
  assert.ok(version, 'a national timplan version in the reference data');
  const decided = await owner.localTimplan.create({
    data: { schoolId, name: 'Beslutad', schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: version.id, status: 'DECIDED', decidedAt: new Date(), decidedByUserId: (await adminOf(owner, schoolId)).userId, decisionNote: 'Beslutad av huvudmannen' },
  });
  const draft = await owner.localTimplan.create({ data: { schoolId, name: 'Utkast', schoolForm: 'GRUNDSKOLA', nationalTimplanVersionId: version.id, status: 'DRAFT' } });
  await owner.academicYearTimplan.create({ data: { schoolId, academicYearId: yearId, gradeLevel: 7, localTimplanId: decided.id } });
  await owner.academicYearTimplan.create({ data: { schoolId, academicYearId: yearId, gradeLevel: 8, localTimplanId: draft.id } });

  return { schoolId, yearId, admin: await adminOf(owner, schoolId), lasare: await adminOf(owner, schoolId, 'LASARE') };
}

async function main(): Promise<void> {
  const owner = new PrismaClient({ adapter: createPgAdapter(requiredEnv('PROBE_OWNER_URL')) });
  const previous = process.env['DATABASE_URL'];
  const api = new PrismaService();
  process.env['DATABASE_URL'] = previous;
  const service = new IntakeService(api);

  const tag = randomUUID().slice(0, 8);
  const cleanup: Array<() => Promise<void>> = [];
  try {
    // (a) an empty school
    const empty = await newSchool(owner, tag, 'tom', cleanup);
    await check('(a) an empty school lacks the year, the subjects, the rooms and the teachers, and waits with the rest for the year', async () => {
      const view = await service.read(await adminOf(owner, empty.schoolId));
      assert.equal(view.year, null);
      assert.deepEqual(present(view), ['NO_YEAR', 'NO_SUBJECTS', 'NO_ROOMS', 'NO_RASTS', 'NO_TEACHERS', 'NO_STUDENTS']);
      assert.deepEqual([view.hard, view.soft, view.info], [4, 1, 1]);
      assert.deepEqual(found(view, 'PEOPLE'), { teachers: 0, students: 0 }, 'the two administrators are no teachers');
    });

    // (b) a school with a little of everything
    const built = await buildSchool(owner, tag, cleanup);
    const view = await service.read(built.admin);
    await check('(b) the year is the active one, and what has been found is the rows made', async () => {
      assert.deepEqual(view.year, { id: built.yearId, name: '2026/2027', isActive: true });
      assert.deepEqual(found(view, 'YEAR'), { years: 1 });
      assert.deepEqual(found(view, 'SUBJECTS'), { subjects: 4 });
      assert.deepEqual(found(view, 'ROOMS'), { rooms: 2 });
      assert.deepEqual(found(view, 'FRAME_TIMES'), { frameTimes: 1 });
      assert.deepEqual(found(view, 'RASTS'), { rasts: 0 });
      assert.deepEqual(found(view, 'CLASSES'), { classes: 7 });
      assert.deepEqual(found(view, 'TEACHING_GROUPS'), { teachingGroups: 4 });
      assert.deepEqual(found(view, 'REQUIREMENTS'), { requirements: 5 });
      assert.deepEqual(found(view, 'STAFFING'), { posts: 4 });
      assert.deepEqual(found(view, 'TIMPLAN'), { gradesWithTimplan: 2 });
    });
    await check('(b) a teacher, an administrator who teaches and a teacher with no post are teachers; a deactivated teacher and an administrator are not', async () => {
      // T1, T2, T3, T5 and the teaching administrator: five. T4 is deactivated and the two other administrators teach nothing.
      assert.deepEqual(found(view, 'PEOPLE'), { teachers: 5, students: 5 });
      assert.equal(gap(view, 'NO_TEACHERS').count, 0);
      assert.equal(gap(view, 'TEACHERS_WITHOUT_POST').count, 1, 'T3 alone has no post');
      assert.equal(gap(view, 'POSTS_WITHOUT_SIGNATURE').count, 2, 'T2\'s and T5\'s posts have none');
      assert.equal(gap(view, 'STUDENTS_WITHOUT_CLASS').count, 1, 'S5; the deactivated S6 is not counted');
    });
    await check('(b) a class is without a post only when nothing reaches it: not its own, not its half, not a group of its pupils', async () => {
      const without = gap(view, 'CLASSES_WITHOUT_POSTS');
      assert.deepEqual(without.items, ['8A', '8B', 'Förb'], '7B (a pupil in Ma7), 9A (a pupil in its half) and 9B (its half has a post, and no pupil of 9B is in it) are not listed, and nor is 7A');
      assert.equal(without.count, 3);
      assert.equal(without.level, 'SOFT');
    });
    await check('(b) a class with no årskurs and a teaching group with no member are found by name', async () => {
      assert.deepEqual(gap(view, 'CLASSES_WITHOUT_GRADE').items, ['Förb']);
      assert.deepEqual(gap(view, 'TEACHING_GROUPS_WITHOUT_MEMBERS').items, ['9B-1', 'En8']);
    });
    await check('(b) a subject with no post, a subject that needs a room type no room has, and a post with no teacher', async () => {
      assert.deepEqual(gap(view, 'SUBJECTS_WITHOUT_POSTS').items, ['Teknik']);
      assert.deepEqual(gap(view, 'ROOM_TYPE_WITHOUT_ROOM').items, ['Slöjd']);
      assert.equal(gap(view, 'ROOM_TYPE_WITHOUT_ROOM').level, 'HARD');
      assert.deepEqual([gap(view, 'UNSTAFFED_POSTS').count, gap(view, 'UNSTAFFED_POSTS').level], [1, 'SOFT']);
    });
    await check('(b) the årskurs no frame time spans, and the lokal timplan that is missing or not decided', async () => {
      assert.deepEqual(gap(view, 'FRAME_TIMES_MISSING').items, ['9']);
      assert.deepEqual(gap(view, 'TIMPLAN_MISSING').items, ['9']);
      assert.deepEqual(gap(view, 'TIMPLAN_NOT_DECIDED').items, ['8']);
    });
    await check('(b) nothing else is a gap, and nothing hard', async () => {
      assert.deepEqual(present(view).sort(), [
        'CLASSES_WITHOUT_GRADE',
        'CLASSES_WITHOUT_POSTS',
        'FRAME_TIMES_MISSING',
        'NO_RASTS',
        'POSTS_WITHOUT_SIGNATURE',
        'ROOM_TYPE_WITHOUT_ROOM',
        'STUDENTS_WITHOUT_CLASS',
        'SUBJECTS_WITHOUT_POSTS',
        'TEACHERS_WITHOUT_POST',
        'TEACHING_GROUPS_WITHOUT_MEMBERS',
        'TIMPLAN_MISSING',
        'TIMPLAN_NOT_DECIDED',
        'UNSTAFFED_POSTS',
      ].sort());
      // One hard (the room type), five soft and seven only for another step.
      assert.deepEqual([view.hard, view.soft, view.info], [1, 5, 7]);
    });

    // (c) the school's choice, and a room of the missing type
    await check('(c) Vägra turns a post with no teacher into a hard gap, and a room of the missing type takes the room-type gap away', async () => {
      await owner.staffingPolicy.upsert({ where: { schoolId: built.schoolId }, create: { schoolId: built.schoolId, unstaffedGeneration: 'REFUSE' }, update: { unstaffedGeneration: 'REFUSE' } });
      const refused = await service.read(built.admin);
      assert.deepEqual([gap(refused, 'UNSTAFFED_POSTS').count, gap(refused, 'UNSTAFFED_POSTS').level], [1, 'HARD']);
      const type = await owner.roomType.findFirstOrThrow({ where: { schoolId: built.schoolId, name: 'Textilslöjd' } });
      await owner.room.create({ data: { schoolId: built.schoolId, name: 'Textilsalen', capacity: 20, roomTypeId: type.id } });
      const withRoom = await service.read(built.admin);
      assert.equal(gap(withRoom, 'ROOM_TYPE_WITHOUT_ROOM').count, 0);
      assert.deepEqual(found(withRoom, 'ROOMS'), { rooms: 3 });
    });

    // (d) another school's rows
    await check('(d) another school\'s rows are never counted', async () => {
      const other = await newSchool(owner, tag, 'annan', cleanup);
      const otherYear = await owner.academicYear.create({ data: { schoolId: other.schoolId, name: '2026/2027', startDate: new Date('2026-08-17'), endDate: new Date('2027-06-11'), gradeNumbering: 'NIOARIG', isActive: true } });
      for (let i = 0; i < 30; i += 1) await owner.room.create({ data: { schoolId: other.schoolId, name: `R${i}`, capacity: 30 } });
      for (let i = 0; i < 12; i += 1) {
        await owner.user.create({ data: { schoolId: other.schoolId, authId: randomUUID(), role: 'TEACHER', firstName: `X${i}`, lastName: 'Annan', email: `x${i}-${tag}@probe.example.com` } });
      }
      await owner.studentGroup.create({ data: { schoolId: other.schoolId, academicYearId: otherYear.id, name: '1A', kind: 'CLASS', gradeLevel: 1 } });
      const again = await service.read(built.admin);
      assert.deepEqual(found(again, 'ROOMS'), { rooms: 3 });
      assert.deepEqual(found(again, 'PEOPLE'), { teachers: 5, students: 5 });
      assert.deepEqual(found(again, 'CLASSES'), { classes: 7 });
      assert.equal(again.year!.id, built.yearId, 'the school\'s own active year, not the other school\'s');
    });

    // (e) a läsare, and a läsår that is not the active one
    await check('(e) a läsare reads what a full administrator reads', async () => {
      assert.deepEqual(await service.read(built.lasare), await service.read(built.admin));
    });
    await check('(e) the rows of a läsår that is not active are never counted: not its classes, its posts or its employments', async () => {
      const before = await service.read(built.admin);
      const old = await owner.academicYear.create({ data: { schoolId: built.schoolId, name: '2025/2026', startDate: new Date('2025-08-18'), endDate: new Date('2026-06-12'), gradeNumbering: 'NIOARIG', isActive: false } });
      const oldClass = await owner.studentGroup.create({ data: { schoolId: built.schoolId, academicYearId: old.id, name: '6A', kind: 'CLASS', gradeLevel: 6 } });
      const teacher3 = await owner.user.findFirstOrThrow({ where: { schoolId: built.schoolId, email: { startsWith: 't3-' } } });
      const subject = await owner.subject.findFirstOrThrow({ where: { schoolId: built.schoolId, name: 'Teknik' } });
      await owner.teachingRequirement.create({ data: { schoolId: built.schoolId, academicYearId: old.id, studentGroupId: oldClass.id, subjectId: subject.id, teacherId: null, lessonsPerWeek: 1, minutesPerLesson: 60 } });
      await owner.teacherEmployment.create({ data: { schoolId: built.schoolId, userId: teacher3.id, academicYearId: old.id, employmentPercent: 50, signature: 'TRE' } });
      const after = await service.read(built.admin);
      // Everything is as it was but how many läsår the school has: T3 has a post in the old year and still none in this one, Teknik has a
      // post in the old year and still none in this one, and the old year's class is no class of this one.
      assert.deepEqual(found(after, 'YEAR'), { years: found(before, 'YEAR').years! + 1 });
      for (const view of [before, after]) view.areas[0]!.found = {};
      assert.deepEqual(after, before);
      assert.equal(gap(after, 'TEACHERS_WITHOUT_POST').count, 1);
      assert.deepEqual(gap(after, 'SUBJECTS_WITHOUT_POSTS').items, ['Teknik']);
      assert.equal(gap(after, 'UNSTAFFED_POSTS').count, 1, 'the old year\'s post with no teacher is not this year\'s');
    });
    await check('(e) a school with no active year waits: NO_YEAR, and the year-bound areas wait instead of saying nothing is missing', async () => {
      await owner.academicYear.updateMany({ where: { schoolId: built.schoolId }, data: { isActive: false } });
      try {
        const view = await service.read(built.admin);
        assert.equal(view.year, null);
        assert.equal(gap(view, 'NO_YEAR').count, 1);
        assert.deepEqual(view.areas.filter((area) => area.waitsForYear).map((area) => area.area), ['CLASSES', 'TEACHING_GROUPS', 'TIMPLAN', 'REQUIREMENTS', 'STAFFING']);
        assert.equal(gap(view, 'NO_CLASSES').count, 0, 'a school with no year has not got no classes: it has no year to have them in');
        assert.deepEqual(found(view, 'ROOMS'), { rooms: 3 }, 'rooms and people belong to the school, not the year');
      } finally {
        await owner.academicYear.update({ where: { id: built.yearId }, data: { isActive: true } });
      }
    });

    // (f) a TIOARIG läsår
    await check('(f) a TIOARIG läsår is held against the frames in NIOARIG: its åk 8 is covered by a frame for åk 7', async () => {
      const { schoolId } = await newSchool(owner, tag, 'tioarig', cleanup);
      const year = await owner.academicYear.create({ data: { schoolId, name: '2028/2029', startDate: new Date('2028-08-15'), endDate: new Date('2029-06-12'), gradeNumbering: 'TIOARIG', isActive: true } });
      await owner.studentGroup.create({ data: { schoolId, academicYearId: year.id, name: '8A', kind: 'CLASS', gradeLevel: 8 } });
      await owner.studentGroup.create({ data: { schoolId, academicYearId: year.id, name: '10A', kind: 'CLASS', gradeLevel: 10 } });
      await owner.frameTime.create({ data: { schoolId, minGradeLevel: 7, maxGradeLevel: 9, startTime: time('08:00'), endTime: time('16:00') } });
      const covered = await service.read(await adminOf(owner, schoolId));
      assert.equal(gap(covered, 'FRAME_TIMES_MISSING').count, 0, 'TIOARIG 8 and 10 are NIOARIG 7 and 9');
      await owner.frameTime.deleteMany({ where: { schoolId } });
      await owner.frameTime.create({ data: { schoolId, minGradeLevel: 8, maxGradeLevel: 9, startTime: time('08:00'), endTime: time('16:00') } });
      const short = await service.read(await adminOf(owner, schoolId));
      assert.deepEqual(gap(short, 'FRAME_TIMES_MISSING').items, ['8'], 'TIOARIG 8 is NIOARIG 7, which a frame for 8–9 does not span');
    });

    // (g) no person in the answer
    await check('(g) the answer holds no address, no name of a person and no percentage of a post', async () => {
      const text = JSON.stringify(await service.read(built.admin));
      assert.doesNotMatch(text, /@|probe\.example|T1|T2|T3|S1|S2|Ada|Lars|Zed|employmentPercent|signature|ABE|ZED/, 'no person is named');
    });
  } finally {
    for (const undo of cleanup.reverse()) await undo().catch((error) => console.error('cleanup:', error));
    await api.$disconnect();
    await owner.$disconnect();
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nintake probe passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
